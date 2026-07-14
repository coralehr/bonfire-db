/** Re-indexing must remove stale search text when the current resource has none. */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertFhirResourceTx, updateFhirResourceTx } from "../db/fhir-store.js";
import { connectTenantDb } from "../db/tenant.js";
import { indexResourceTx } from "./index-doc.js";

const db = connectTenantDb({ max: 1 });

afterAll(() => db.end());

describe("search projection replacement", () => {
  test("re-indexing empty searchable content deletes the previous search_doc", async () => {
    const practiceId = randomUUID();
    const resourceId = randomUUID();
    let stage = "insert";
    const outcome = await db.withTenant(practiceId, async (sql) => {
      const original = {
        resourceType: "Patient",
        id: resourceId,
        name: [{ family: "StaleSearchText" }]
      };
      const inserted = await insertFhirResourceTx(sql, {
        id: resourceId,
        type: "Patient",
        content: original,
        rawPayload: JSON.stringify(original)
      });
      if (!inserted.ok) throw new Error(inserted.error.code);
      stage = "initial index";
      const indexed = await indexResourceTx(sql, resourceId);
      if (!indexed.ok) throw new Error(indexed.error.code);
      expect(indexed.data.indexed).toBe(true);

      stage = "canonical update";
      const updated = await updateFhirResourceTx(sql, {
        id: resourceId,
        content: { resourceType: "Patient", id: resourceId },
        expectedVersionId: "1"
      });
      if (!updated.ok) throw new Error(updated.error.code);
      stage = "empty re-index";
      const reindexed = await indexResourceTx(sql, resourceId);
      if (!reindexed.ok) throw new Error(reindexed.error.code);
      stage = "search readback";
      const rows =
        await sql`select source_version_id from search_doc where resource_id = ${resourceId}`;
      return { indexed: reindexed.data.indexed, searchRows: rows.length };
    });

    if (!outcome.ok) throw new Error(`tenant transaction failed during ${stage}`);
    expect(outcome.data).toEqual({ indexed: false, searchRows: 0 });
  });
});
