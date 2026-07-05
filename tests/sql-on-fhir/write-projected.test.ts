/**
 * writeScribeResourceProjected — the composed ONE write path (BF-04 close-out):
 * canonical write + vd_* + spidx upsert commit together, and a projection
 * failure after the canonical insert rolls the WHOLE transaction back (the
 * fail-closed asymmetry: return err pre-DML, throw post-DML).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  parseMaterializableView,
  writeScribeResourceProjected
} from "../../packages/sql-on-fhir/src/index.js";
import type { TestContext } from "./helpers.js";
import { registerRebuiltContext } from "./helpers.js";

let ctx: TestContext;
registerRebuiltContext((c) => {
  ctx = c;
});

function patientScribe(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "https://example.org/synthetic-mrn", value: `MRN-${id.slice(0, 8)}` }],
    name: [{ family: "Projected", given: ["Synthetic"] }],
    gender: "female"
  };
}

describe("one write path: canonical + projections commit together", () => {
  test("a projected scribe write lands the canonical row, vd row and spidx rows atomically", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, patientScribe(id), ctx.views);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(true);
    if (!result.data.ok) return;
    expect(result.data.data.projection.vdRows).toBeGreaterThanOrEqual(1);
    expect(result.data.data.projection.spidxRows).toBeGreaterThanOrEqual(1);
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${id}) as canonical,
        (select count(*) from vd_patient_demographics where id = ${id}) as vd,
        (select count(*) from spidx where resource_id = ${id}) as spidx`;
    expect(counts[0]?.canonical).toBe("1");
    expect(counts[0]?.vd).toBe("1");
    expect(Number(counts[0]?.spidx)).toBeGreaterThanOrEqual(1);
  });

  test("views default to the staged scribe ViewDefinitions when omitted", async () => {
    const practice = randomUUID();
    const id = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, patientScribe(id));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(true);
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
    const hostile = parseMaterializableView({
      name: "patient_hostile_probe",
      resource: "Patient",
      status: "active",
      select: [
        {
          column: [
            { name: "id", path: "getResourceKey()", type: "id" },
            { name: "family_name", path: "name.family", type: "string" }
          ]
        }
      ]
    });
    expect(hostile.ok).toBe(true);
    if (!hostile.ok) return;
    const practice = randomUUID();
    const id = randomUUID();
    const twoNames = {
      ...patientScribe(id),
      name: [{ family: "First" }, { family: "Second" }]
    };
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await writeScribeResourceProjected(sql, twoNames, [hostile.data]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_TX_FAILED");
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${id}) as canonical,
        (select count(*) from history where id = ${id}) as history,
        (select count(*) from write_inputs where fhir_resource_id = ${id}) as inputs,
        (select count(*) from spidx where resource_id = ${id}) as spidx`;
    expect(counts[0]?.canonical).toBe("0");
    expect(counts[0]?.history).toBe("0");
    expect(counts[0]?.inputs).toBe("0");
    expect(counts[0]?.spidx).toBe("0");
  });
});
