import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSqlClient } from "../db/client.js";
import { resolveDatabaseTarget } from "../db/env.js";
import { connectTenantDb } from "../db/tenant.js";
import { insertFhirResourceTx, updateFhirResourceTx } from "../db/fhir-store.js";
import { compareReferenceProjectionTx, replaceReferenceEdgesTx } from "./projection.js";
import { createReferenceGraphReader } from "./sql-reader.js";
import { walkReferenceGraph } from "./walk.js";

const db = connectTenantDb({ max: 1 });
const rawApp = createSqlClient(resolveDatabaseTarget(), { max: 1 });

afterAll(async () => {
  await db.end();
  await rawApp.end({ timeout: 5 });
});

describe("tenant-scoped explicit-reference projection", () => {
  test("parity fails for never-projected empty resources and unchanged-reference version bumps", async () => {
    const practiceId = randomUUID();
    const patientId = randomUUID();
    const reportId = randomUUID();
    const observationId = randomUUID();
    const result = await db.withTenant(practiceId, async (sql) => {
      const patient = { resourceType: "Patient", id: patientId };
      const insertedPatient = await insertFhirResourceTx(sql, {
        id: patientId,
        type: "Patient",
        content: patient,
        rawPayload: JSON.stringify(patient)
      });
      if (!insertedPatient.ok) throw new Error(insertedPatient.error.code);
      const absent = await compareReferenceProjectionTx(sql, patientId);
      if (!absent.ok) throw new Error(absent.error.code);

      const report = {
        resourceType: "DiagnosticReport",
        id: reportId,
        result: [{ reference: `Observation/${observationId}` }],
        status: "preliminary"
      };
      const insertedReport = await insertFhirResourceTx(sql, {
        id: reportId,
        type: "DiagnosticReport",
        content: report,
        rawPayload: JSON.stringify(report)
      });
      if (!insertedReport.ok) throw new Error(insertedReport.error.code);
      const projected = await replaceReferenceEdgesTx(sql, reportId);
      if (!projected.ok) throw new Error(projected.error.code);
      const updated = await updateFhirResourceTx(sql, {
        id: reportId,
        expectedVersionId: "1",
        content: { ...report, status: "final" }
      });
      if (!updated.ok) throw new Error(updated.error.code);
      const stale = await compareReferenceProjectionTx(sql, reportId);
      if (!stale.ok) throw new Error(stale.error.code);
      return { absent: absent.data, stale: stale.data };
    });

    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.absent).toMatchObject({
      equal: false,
      headPresent: false,
      storedEdgeCount: 0,
      freshEdgeCount: 0,
      storedSourceVersionId: null
    });
    expect(result.data.stale).toMatchObject({
      equal: false,
      headPresent: true,
      sourceVersionId: "2",
      storedSourceVersionId: "1"
    });
  });

  test("replaces stale edges and produces a byte-identical parity receipt", async () => {
    const practiceId = randomUUID();
    const patientId = randomUUID();
    const reportId = randomUUID();
    const oldObservationId = randomUUID();
    const specimenId = randomUUID();
    const result = await db.withTenant(practiceId, async (sql) => {
      const patient = { resourceType: "Patient", id: patientId };
      const insertedPatient = await insertFhirResourceTx(sql, {
        id: patientId,
        type: "Patient",
        content: patient,
        rawPayload: JSON.stringify(patient)
      });
      if (!insertedPatient.ok) throw new Error(insertedPatient.error.code);
      const original = {
        resourceType: "DiagnosticReport",
        id: reportId,
        subject: { reference: `Patient/${patientId}` },
        result: [{ reference: `Observation/${oldObservationId}` }]
      };
      const insertedReport = await insertFhirResourceTx(sql, {
        id: reportId,
        type: "DiagnosticReport",
        content: original,
        rawPayload: JSON.stringify(original)
      });
      if (!insertedReport.ok) throw new Error(insertedReport.error.code);
      const first = await replaceReferenceEdgesTx(sql, reportId);
      if (!first.ok) throw new Error(first.error.code);
      expect(first.data).toMatchObject({ edgeCount: 2, sourceVersionId: "1" });

      const revised = {
        resourceType: "DiagnosticReport",
        id: reportId,
        subject: { reference: `Patient/${patientId}` },
        specimen: [{ reference: `Specimen/${specimenId}/_history/3` }]
      };
      const updated = await updateFhirResourceTx(sql, {
        id: reportId,
        content: revised,
        expectedVersionId: "1"
      });
      if (!updated.ok) throw new Error(updated.error.code);
      const second = await replaceReferenceEdgesTx(sql, reportId);
      if (!second.ok) throw new Error(second.error.code);
      const parity = await compareReferenceProjectionTx(sql, reportId);
      if (!parity.ok) throw new Error(parity.error.code);
      const stored = await sql`
        select source_version_id::text as source_version_id, json_path,
          target_resource_id, target_version_id
        from fhir_reference_edges where source_resource_id = ${reportId}
        order by json_path`;
      return { second: second.data, parity: parity.data, stored };
    });

    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.second).toMatchObject({ edgeCount: 2, sourceVersionId: "2" });
    expect(result.data.parity).toMatchObject({
      equal: true,
      storedEdgeCount: 2,
      freshEdgeCount: 2,
      sourceVersionId: "2"
    });
    expect(result.data.stored).toEqual([
      {
        source_version_id: "2",
        json_path: "/specimen/0/reference",
        target_resource_id: specimenId,
        target_version_id: "3"
      },
      {
        source_version_id: "2",
        json_path: "/subject/reference",
        target_resource_id: patientId,
        target_version_id: null
      }
    ]);
  });

  test("the SQL reader and walker resolve only visible, allowed targets", async () => {
    const practiceId = randomUUID();
    const patientId = randomUUID();
    const reportId = randomUUID();
    const missingObservationId = randomUUID();
    const result = await db.withTenant(practiceId, async (sql) => {
      for (const [id, type, content] of [
        [patientId, "Patient", { resourceType: "Patient", id: patientId }],
        [
          reportId,
          "DiagnosticReport",
          {
            resourceType: "DiagnosticReport",
            id: reportId,
            subject: { reference: `Patient/${patientId}` },
            result: [{ reference: `Observation/${missingObservationId}` }]
          }
        ]
      ] as const) {
        const inserted = await insertFhirResourceTx(sql, {
          id,
          type,
          content,
          rawPayload: JSON.stringify(content)
        });
        if (!inserted.ok) throw new Error(inserted.error.code);
        const projected = await replaceReferenceEdgesTx(sql, id);
        if (!projected.ok) throw new Error(projected.error.code);
      }
      return walkReferenceGraph(
        [{ resourceType: "DiagnosticReport", resourceId: reportId }],
        createReferenceGraphReader(sql),
        {
          profile: "clinical-reference-v1",
          allowedResourceTypes: ["Patient", "Observation"],
          maxDepth: 1,
          maxTargets: 4,
          maxEdges: 4,
          maxCitations: 4
        }
      );
    });

    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.targets.map((target) => target.resourceId)).toEqual([patientId]);
    expect(result.data.citations.map((citation) => citation.status)).toEqual([
      "missing",
      "fetched"
    ]);
  });

  test("same logical id is isolated by practice and no GUC reveals zero edges", async () => {
    const practiceA = randomUUID();
    const practiceB = randomUUID();
    const sharedReportId = randomUUID();
    const targetA = randomUUID();
    const targetB = randomUUID();
    const seed = async (practiceId: string, targetId: string): Promise<void> => {
      const outcome = await db.withTenant(practiceId, async (sql) => {
        const content = {
          resourceType: "DiagnosticReport",
          id: sharedReportId,
          result: [{ reference: `Observation/${targetId}` }]
        };
        const inserted = await insertFhirResourceTx(sql, {
          id: sharedReportId,
          type: "DiagnosticReport",
          content,
          rawPayload: JSON.stringify(content)
        });
        if (!inserted.ok) throw new Error(inserted.error.code);
        const projected = await replaceReferenceEdgesTx(sql, sharedReportId);
        if (!projected.ok) throw new Error(projected.error.code);
      });
      if (!outcome.ok) throw new Error(outcome.error.code);
    };
    await seed(practiceA, targetA);
    await seed(practiceB, targetB);

    const visible = async (practiceId: string): Promise<string[]> => {
      const outcome = await db.withTenant(practiceId, async (sql) => {
        const rows = await sql`
          select target_resource_id from fhir_reference_edges
          where source_resource_id = ${sharedReportId}`;
        return rows.map((row) => String(row.target_resource_id));
      });
      if (!outcome.ok) throw new Error(outcome.error.code);
      return outcome.data;
    };
    expect(await visible(practiceA)).toEqual([targetA]);
    expect(await visible(practiceB)).toEqual([targetB]);
    expect(await rawApp`select target_resource_id from fhir_reference_edges`).toEqual([]);
    const garbage = await rawApp.begin(async (sql) => {
      await sql`select set_config('app.current_practice_id', 'not-a-uuid', true)`;
      return sql`select target_resource_id from fhir_reference_edges`;
    });
    expect(garbage).toEqual([]);
    const [posture] = await rawApp<
      { readonly update_allowed: boolean; readonly delete_allowed: boolean }[]
    >`
      select has_table_privilege('bonfire_app', 'fhir_reference_edges', 'UPDATE') as update_allowed,
        has_table_privilege('bonfire_app', 'fhir_reference_edges', 'DELETE') as delete_allowed`;
    expect(posture).toEqual({ update_allowed: false, delete_allowed: true });
  });
});
