/**
 * writeScribeResourceProjected — the composed ONE write path (BF-04 close-out):
 * canonical write + vd_* + spidx upsert commit together, and a projection
 * failure after the canonical insert rolls the WHOLE transaction back (the
 * fail-closed asymmetry: return err pre-DML, throw post-DML).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { err, indexResourceTx } from "../../packages/core/src/index.js";
import {
  updateFhirResourceProjected,
  writeScribeResourceProjected
} from "../../packages/sql-on-fhir/src/index.js";
import type { TestContext } from "./helpers.js";
import {
  hostilePatientNameView,
  registerRebuiltContext,
  syntheticPatientScribe
} from "./helpers.js";

let ctx: TestContext;
registerRebuiltContext((c) => {
  ctx = c;
});

describe("one write path: canonical + projections commit together", () => {
  test("a projected scribe write lands the canonical row, vd row and spidx rows atomically", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, syntheticPatientScribe(id), ctx.views);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(true);
    if (!result.data.ok) return;
    expect(result.data.data.projection.vdRows).toBeGreaterThanOrEqual(1);
    expect(result.data.data.projection.spidxRows).toBeGreaterThanOrEqual(1);
    expect(result.data.data.references.edgeCount).toBe(0);
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${id}) as canonical,
        (select count(*) from vd_patient_demographics where id = ${id}) as vd,
        (select count(*) from spidx where resource_id = ${id}) as spidx,
        (select count(*) from fhir_reference_edges where source_resource_id = ${id}) as reference_edges`;
    expect(counts[0]?.canonical).toBe("1");
    expect(counts[0]?.vd).toBe("1");
    expect(Number(counts[0]?.spidx)).toBeGreaterThanOrEqual(1);
    expect(counts[0]?.reference_edges).toBe("0");
  });

  test("views default to the staged scribe ViewDefinitions when omitted", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, syntheticPatientScribe(id));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(true);
  });

  test("a projected clinical write atomically materializes its explicit FHIR reference", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const patientId = randomUUID();
    const observation = {
      resourceType: "Observation",
      id,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs"
            }
          ]
        }
      ],
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: "2026-07-13T00:00:00Z",
      valueQuantity: { value: 120, unit: "mmHg" }
    };
    const result = await ctx.db.withTenant(practice, (sql) =>
      writeScribeResourceProjected(sql, observation, ctx.views)
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data.ok) return;
    expect(result.data.data.references.edgeCount).toBe(1);
    const rows = await ctx.owner`
      select source_resource_type, json_path, target_resource_type, target_resource_id
      from fhir_reference_edges where source_resource_id = ${id}`;
    expect(rows).toEqual([
      {
        source_resource_type: "Observation",
        json_path: "/subject/reference",
        target_resource_type: "Patient",
        target_resource_id: patientId
      }
    ]);
  });

  test("a projected update replaces stale references and binds the new source version", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const firstPatientId = randomUUID();
    const secondPatientId = randomUUID();
    const observation = {
      resourceType: "Observation",
      id,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs"
            }
          ]
        }
      ],
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
      subject: { reference: `Patient/${firstPatientId}` },
      effectiveDateTime: "2026-07-13T00:00:00Z",
      valueQuantity: { value: 120, unit: "mmHg" }
    };
    const inserted = await ctx.db.withTenant(practice, (sql) =>
      writeScribeResourceProjected(sql, observation, ctx.views)
    );
    expect(inserted.ok).toBe(true);
    const updated = await ctx.db.withTenant(practice, (sql) =>
      updateFhirResourceProjected(
        sql,
        {
          id,
          expectedVersionId: "1",
          content: {
            ...observation,
            subject: { reference: `Patient/${secondPatientId}` },
            valueQuantity: { value: 121, unit: "mmHg" }
          }
        },
        ctx.views
      )
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok || !updated.data.ok) return;
    expect(updated.data.data.record.versionId).toBe("2");
    expect(updated.data.data.references.sourceVersionId).toBe("2");
    const rows = await ctx.owner`
      select e.source_version_id::text as source_version_id, e.target_resource_id,
        h.source_version_id::text as head_version
      from fhir_reference_edges e
      join fhir_reference_projection_heads h using (practice_id, source_resource_id)
      where e.practice_id = ${practice} and e.source_resource_id = ${id}`;
    expect(rows).toEqual([
      {
        source_version_id: "2",
        target_resource_id: secondPatientId,
        head_version: "2"
      }
    ]);
  });

  test("a failed reference rebuild rolls back a canonical update and its old edge", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const patientId = randomUUID();
    const observation = {
      resourceType: "Observation",
      id,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs"
            }
          ]
        }
      ],
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: "2026-07-13T00:00:00Z",
      valueQuantity: { value: 120, unit: "mmHg" }
    };
    const inserted = await ctx.db.withTenant(practice, (sql) =>
      writeScribeResourceProjected(sql, observation, ctx.views)
    );
    expect(inserted.ok).toBe(true);
    const failed = await ctx.db.withTenant(practice, (sql) =>
      updateFhirResourceProjected(
        sql,
        {
          id,
          expectedVersionId: "1",
          content: { ...observation, valueQuantity: { value: 122, unit: "mmHg" } }
        },
        ctx.views,
        indexResourceTx,
        async () =>
          err({
            code: "REFERENCE_RESOURCE_NOT_FOUND" as const,
            message: "synthetic forced update projection failure"
          })
      )
    );
    expect(failed.ok).toBe(false);
    const rows = await ctx.owner`
      select r.version_id::text as resource_version,
        e.source_version_id::text as edge_version,
        e.target_resource_id,
        h.source_version_id::text as head_version,
        (select count(*) from history where practice_id = ${practice}
          and id = ${id}) as history_count
      from fhir_resources r
      join fhir_reference_edges e on e.practice_id = r.practice_id
        and e.source_resource_id = r.id
      join fhir_reference_projection_heads h on h.practice_id = r.practice_id
        and h.source_resource_id = r.id
      where r.practice_id = ${practice} and r.id = ${id}`;
    expect(rows).toEqual([
      {
        resource_version: "1",
        edge_version: "1",
        target_resource_id: patientId,
        head_version: "1",
        history_count: "1"
      }
    ]);
  });

  test("an invalid scribe input is a typed err with zero rows anywhere", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, { resourceType: "Patient", id }, ctx.views);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(false);
    const counts = await ctx.owner`
      select (select count(*) from fhir_resources where id = ${id}) as canonical`;
    expect(counts[0]?.canonical).toBe("0");
  });

  test("a projection failure AFTER the canonical insert rolls the whole tx back", async () => {
    // A hostile-but-valid view: name.family without collection:true errors
    // (VD_COLUMN_MULTIPLE_VALUES) for a patient with two names — the
    // projection err surfaces after insertFhirResourceTx has run, so the
    // composed function must THROW and withTenant must roll everything back.
    const hostile = hostilePatientNameView("patient_hostile_probe");
    const practice = randomUUID();
    const id = randomUUID();
    const twoNames = {
      ...syntheticPatientScribe(id),
      name: [{ family: "First" }, { family: "Second" }]
    };
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, twoNames, [hostile]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_TX_FAILED");
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${id}) as canonical,
        (select count(*) from history where id = ${id}) as history,
        (select count(*) from write_inputs where fhir_resource_id = ${id}) as inputs,
        (select count(*) from spidx where resource_id = ${id}) as spidx,
        (select count(*) from fhir_reference_edges where source_resource_id = ${id}) as reference_edges`;
    expect(counts[0]?.canonical).toBe("0");
    expect(counts[0]?.history).toBe("0");
    expect(counts[0]?.inputs).toBe("0");
    expect(counts[0]?.spidx).toBe("0");
    expect(counts[0]?.reference_edges).toBe("0");
  });

  test("a reference projection failure rolls back canonical, typed, search and edge state", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return writeScribeResourceProjected(
        sql,
        syntheticPatientScribe(id),
        ctx.views,
        indexResourceTx,
        async () =>
          err({
            code: "REFERENCE_RESOURCE_NOT_FOUND" as const,
            message: "synthetic forced reference failure"
          })
      );
    });
    expect(result.ok).toBe(false);
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${id}) as canonical,
        (select count(*) from history where id = ${id}) as history,
        (select count(*) from write_inputs where fhir_resource_id = ${id}) as inputs,
        (select count(*) from vd_patient_demographics where id = ${id}) as vd,
        (select count(*) from spidx where resource_id = ${id}) as spidx,
        (select count(*) from search_doc where resource_id = ${id}) as search,
        (select count(*) from fhir_reference_edges where source_resource_id = ${id}) as reference_edges`;
    expect(counts[0]).toEqual({
      canonical: "0",
      history: "0",
      inputs: "0",
      vd: "0",
      spidx: "0",
      search: "0",
      reference_edges: "0"
    });
  });
});
