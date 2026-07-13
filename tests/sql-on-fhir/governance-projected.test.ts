/**
 * Governance commit composition: an approved proposal reaches every current
 * read model through the projected writer in the same tenant transaction.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { GovernanceActor, Result, TenantSql } from "../../packages/core/src/index.js";
import { approveProposal, commitProposal, proposeRecord } from "../../packages/core/src/index.js";
import {
  commitProjectedProposal,
  parseMaterializableView,
  writeScribeResourceProjected
} from "../../packages/sql-on-fhir/src/index.js";
import type { TestContext } from "./helpers.js";
import { registerRebuiltContext } from "./helpers.js";

let ctx: TestContext;
registerRebuiltContext((value) => {
  ctx = value;
});

async function committed<T>(practiceId: string, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const result = await ctx.db.withTenant(practiceId, fn);
  if (!result.ok) throw new Error(`tenant transaction failed: ${result.error.code}`);
  return result.data;
}

function unwrap<T>(result: Result<T, { readonly code: string }>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.data;
}

function actor(role: "agent" | "clinician", practiceId: string): GovernanceActor {
  return { id: `${role}-${practiceId.slice(0, 8)}`, role, practiceId };
}

function patientScribe(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "https://example.org/synthetic-mrn", value: `MRN-${id.slice(0, 8)}` }],
    name: [{ family: "Governed", given: ["Synthetic"] }],
    gender: "female"
  };
}

describe("governed projected write", () => {
  test("propose -> approve -> commit publishes one canonical version to vd, spidx, and search", async () => {
    const practiceId = randomUUID();
    const resourceId = randomUUID();
    const proposed = unwrap(
      await committed(practiceId, (sql) =>
        proposeRecord(sql, {
          actor: actor("agent", practiceId),
          resource: patientScribe(resourceId)
        })
      )
    );
    unwrap(
      await committed(practiceId, (sql) =>
        approveProposal(sql, {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        })
      )
    );

    const signed = unwrap(
      await committed(practiceId, (sql) =>
        commitProjectedProposal(sql, {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        })
      )
    );

    expect(signed.resource).toEqual({
      resourceType: "Patient",
      resourceId,
      versionId: "1"
    });
    const rows = await ctx.owner`
      select
        (select count(*) from fhir_resources where practice_id = ${practiceId}
          and id = ${resourceId} and version_id = 1) as canonical,
        (select count(*) from vd_patient_demographics where practice_id = ${practiceId}
          and id = ${resourceId}) as vd,
        (select count(*) from spidx where practice_id = ${practiceId}
          and resource_id = ${resourceId}) as spidx,
        (select count(*) from search_doc where practice_id = ${practiceId}
          and resource_id = ${resourceId} and source_version_id = 1) as search`;
    expect(rows[0]).toEqual({ canonical: "1", vd: "1", spidx: "1", search: "1" });
  });

  test("projection failure rolls back the canonical write and every commit artifact", async () => {
    const practiceId = randomUUID();
    const resourceId = randomUUID();
    const proposed = unwrap(
      await committed(practiceId, (sql) =>
        proposeRecord(sql, {
          actor: actor("agent", practiceId),
          resource: {
            ...patientScribe(resourceId),
            name: [{ family: "First" }, { family: "Second" }]
          }
        })
      )
    );
    unwrap(
      await committed(practiceId, (sql) =>
        approveProposal(sql, {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        })
      )
    );
    const hostile = parseMaterializableView({
      name: "patient_governance_failure_probe",
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

    const commit = await ctx.db.withTenant(practiceId, (sql) =>
      commitProposal(
        sql,
        {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        },
        (tx, resource) => writeScribeResourceProjected(tx, resource, [hostile.data])
      )
    );
    expect(commit.ok).toBe(false);
    if (!commit.ok) expect(commit.error.code).toBe("TENANT_TX_FAILED");

    const rows = await ctx.owner`
      select
        (select count(*) from fhir_resources where practice_id = ${practiceId}
          and id = ${resourceId}) as canonical,
        (select count(*) from history where practice_id = ${practiceId}
          and id = ${resourceId}) as history,
        (select count(*) from write_inputs where practice_id = ${practiceId}
          and fhir_resource_id = ${resourceId}) as inputs,
        (select count(*) from vd_patient_demographics where practice_id = ${practiceId}
          and id = ${resourceId}) as vd,
        (select count(*) from spidx where practice_id = ${practiceId}
          and resource_id = ${resourceId}) as spidx,
        (select count(*) from search_doc where practice_id = ${practiceId}
          and resource_id = ${resourceId}) as search,
        (select count(*) from governance_event where practice_id = ${practiceId}
          and proposal_id = ${proposed.proposalId} and action = 'commit') as commit_event,
        (select count(*) from governance_signed_note where practice_id = ${practiceId}
          and proposal_id = ${proposed.proposalId}) as signed_note,
        (select count(*) from audit_log where practice_id = ${practiceId}
          and resource_type = 'Governance.commit') as commit_audit`;
    expect(rows[0]).toEqual({
      canonical: "0",
      history: "0",
      inputs: "0",
      vd: "0",
      spidx: "0",
      search: "0",
      commit_event: "0",
      signed_note: "0",
      commit_audit: "0"
    });
  });

  test("search-step failure rolls back already-written vd and spidx rows", async () => {
    const practiceId = randomUUID();
    const resourceId = randomUUID();
    const proposed = unwrap(
      await committed(practiceId, (sql) =>
        proposeRecord(sql, {
          actor: actor("agent", practiceId),
          resource: patientScribe(resourceId)
        })
      )
    );
    unwrap(
      await committed(practiceId, (sql) =>
        approveProposal(sql, {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        })
      )
    );

    let searchStepReached = false;
    const commit = await ctx.db.withTenant(practiceId, (sql) =>
      commitProposal(
        sql,
        {
          actor: actor("clinician", practiceId),
          proposalId: proposed.proposalId
        },
        (tx, resource) =>
          writeScribeResourceProjected(tx, resource, ctx.views, async (indexSql, indexId) => {
            const projected = await indexSql`
              select
                (select count(*) from vd_patient_demographics where id = ${indexId}) as vd,
                (select count(*) from spidx where resource_id = ${indexId}) as spidx`;
            expect(projected[0]?.vd).toBe("1");
            expect(Number(projected[0]?.spidx)).toBeGreaterThanOrEqual(1);
            searchStepReached = true;
            throw new Error("injected search projection failure");
          })
      )
    );
    expect(searchStepReached).toBe(true);
    expect(commit.ok).toBe(false);
    if (!commit.ok) expect(commit.error.code).toBe("TENANT_TX_FAILED");

    const rows = await ctx.owner`
      select
        (select count(*) from fhir_resources where practice_id = ${practiceId}
          and id = ${resourceId}) as canonical,
        (select count(*) from history where practice_id = ${practiceId}
          and id = ${resourceId}) as history,
        (select count(*) from write_inputs where practice_id = ${practiceId}
          and fhir_resource_id = ${resourceId}) as inputs,
        (select count(*) from vd_patient_demographics where practice_id = ${practiceId}
          and id = ${resourceId}) as vd,
        (select count(*) from spidx where practice_id = ${practiceId}
          and resource_id = ${resourceId}) as spidx,
        (select count(*) from search_doc where practice_id = ${practiceId}
          and resource_id = ${resourceId}) as search,
        (select count(*) from governance_event where practice_id = ${practiceId}
          and proposal_id = ${proposed.proposalId} and action = 'commit') as commit_event,
        (select count(*) from governance_signed_note where practice_id = ${practiceId}
          and proposal_id = ${proposed.proposalId}) as signed_note,
        (select count(*) from audit_log where practice_id = ${practiceId}
          and resource_type = 'Governance.commit') as commit_audit`;
    expect(rows[0]).toEqual({
      canonical: "0",
      history: "0",
      inputs: "0",
      vd: "0",
      spidx: "0",
      search: "0",
      commit_event: "0",
      signed_note: "0",
      commit_audit: "0"
    });
  });
});
