/**
 * Governance store battery against the live DB (dangerChecks:
 * propose-only-broken, fail-open-authz, audit-bypass). Proves the audit
 * contract end to end: a deny COMMITS exactly one hash-chain-linked deny row
 * with zero mutations (err is a value); an allow's row lands in the same
 * transaction as its mutation; an illegal transition by an authorized actor is
 * a typed err with the chain LITERALLY unchanged; and no fhir_resources row
 * exists before a clinician-approved commit (honest staging). Practices are
 * fresh randomUUIDs per test so chain lengths and counts are exact.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSqlClient } from "../db/client.js";
import { resolveDatabaseTarget } from "../db/env.js";
import { createTenantDb } from "../db/tenant.js";
import type { GovernanceActor, GovernanceRole, Result, TenantSql } from "../index.js";
import {
  approveProposal,
  commitProposal,
  proposeRecord,
  signedNoteSchema,
  verifyAuditChainTx
} from "../index.js";

const db = createTenantDb(createSqlClient(resolveDatabaseTarget(), { max: 5 }));

afterAll(async () => {
  await db.end();
});

/** Unwrap the OUTER withTenant Result: deny paths COMMIT (outer ok); only DB faults roll back. */
async function committed<T>(practice: string, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const outer = await db.withTenant(practice, fn);
  if (!outer.ok) throw new Error(`tenant tx rolled back: ${outer.error.code}`);
  return outer.data;
}

/** Unwrap an INNER governance Result expected to be ok. */
function unwrap<T>(result: Result<T, { code: string; message: string }>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.data;
}

/** Assert an INNER governance Result is a typed err and return its code. */
function errCode<T>(result: Result<T, { code: string; message: string }>): string {
  if (result.ok) throw new Error("expected a typed err result");
  return result.error.code;
}

function actorFor(role: GovernanceRole, practice: string): GovernanceActor {
  return { id: `${role}-${practice.slice(0, 8)}`, role, practiceId: practice };
}

function draftPatient(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "urn:bonfire:test-mrn", value: id.slice(0, 6) }],
    name: [{ family: "Governancecase" }],
    gender: "female"
  };
}

interface AuditRow {
  actor_id: string;
  decision: string;
  resource_type: string;
  reason: string;
  row_hash: string;
}

/** The practice's audit chain rows in seq order (RLS-scoped to the tenant). */
async function auditTrail(practice: string): Promise<AuditRow[]> {
  return committed(practice, async (sql) => {
    const rows = await sql<AuditRow[]>`
      select actor_id, decision, resource_type, reason, row_hash
      from audit_log order by audit_log.seq asc`;
    return Array.from(rows);
  });
}

async function countOf(
  practice: string,
  query: (sql: TenantSql) => Promise<number>
): Promise<number> {
  return committed(practice, query);
}

async function eventRows(
  practice: string,
  proposalId: string
): Promise<{ action: string; actor_id: string; audit_row_hash: string }[]> {
  return committed(practice, async (sql) => {
    const rows = await sql<{ action: string; actor_id: string; audit_row_hash: string }[]>`
      select action, actor_id, audit_row_hash from governance_event
      where proposal_id = ${proposalId} order by occurred_at asc`;
    return Array.from(rows);
  });
}

async function fhirCount(practice: string): Promise<number> {
  return countOf(practice, async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from fhir_resources`;
    return rows[0]?.n ?? -1;
  });
}

async function proposeDraft(practice: string, by: GovernanceActor): Promise<string> {
  const inner = await committed(practice, (sql) =>
    proposeRecord(sql, { actor: by, resource: draftPatient(randomUUID()) })
  );
  return unwrap(inner).proposalId;
}

/** Stage a proposal as the agent and approve it as the clinician. */
async function approvedDraft(
  practice: string
): Promise<{ clinician: GovernanceActor; proposalId: string }> {
  const clinician = actorFor("clinician", practice);
  const proposalId = await proposeDraft(practice, actorFor("agent", practice));
  unwrap(
    await committed(practice, (sql) => approveProposal(sql, { actor: clinician, proposalId }))
  );
  return { clinician, proposalId };
}

/** Stage (agent) + approve (clinician) a draft whose FHIR resource id is pinned. */
async function approvedDraftFor(practice: string, resourceId: string): Promise<string> {
  const proposalId = unwrap(
    await committed(practice, (sql) =>
      proposeRecord(sql, { actor: actorFor("agent", practice), resource: draftPatient(resourceId) })
    )
  ).proposalId;
  unwrap(
    await committed(practice, (sql) =>
      approveProposal(sql, { actor: actorFor("clinician", practice), proposalId })
    )
  );
  return proposalId;
}

describe("propose: honest staging (acceptance #4)", () => {
  test("agent propose -> ok, proposal staged, ONE allow row, fhir_resources untouched", async () => {
    const practice = randomUUID();
    const agent = actorFor("agent", practice);
    const inner = await committed(practice, (sql) =>
      proposeRecord(sql, { actor: agent, resource: draftPatient(randomUUID()) })
    );
    const record = unwrap(inner);
    expect(record.state).toBe("proposed");

    const proposals = await countOf(practice, async (sql) => {
      const rows = await sql<{ proposer_actor_id: string; proposer_role: string }[]>`
        select proposer_actor_id, proposer_role from governance_proposal
        where id = ${record.proposalId}`;
      expect(rows[0]?.proposer_actor_id).toBe(agent.id);
      expect(rows[0]?.proposer_role).toBe("agent");
      return rows.length;
    });
    expect(proposals).toBe(1);

    const trail = await auditTrail(practice);
    expect(trail.length).toBe(1);
    expect(trail[0]?.decision).toBe("allow");
    expect(trail[0]?.resource_type).toBe("Governance.propose");
    expect(trail[0]?.actor_id).toBe(agent.id);
    // Honest staging: proposing NEVER touches the clinical record.
    expect(await fhirCount(practice)).toBe(0);
  });

  test("an invalid scribe resource -> INVALID_SCRIBE_INPUT with ZERO audit rows", async () => {
    const practice = randomUUID();
    const inner = await committed(practice, (sql) =>
      proposeRecord(sql, {
        actor: actorFor("agent", practice),
        resource: { resourceType: "Patient", id: "not-a-uuid" }
      })
    );
    expect(errCode(inner)).toBe("INVALID_SCRIBE_INPUT");
    expect((await auditTrail(practice)).length).toBe(0);
  });

  test("a value-shifting getter actor can't split audit attribution from the staged proposer", async () => {
    // The actor is untrusted (`actor: unknown`). A getter that returns a fresh
    // id on every read would, under a double-parse, let the audit row attribute
    // the propose to one id while the proposal records another — a forged split
    // between the tamper-evident chain and the persisted state. The store reads
    // the actor ONCE, so both must land on the same identity.
    const practice = randomUUID();
    let reads = 0;
    const hostile = {
      get id(): string {
        reads += 1;
        return `agent-${reads}`;
      },
      role: "agent",
      practiceId: practice
    };
    const record = unwrap(
      await committed(practice, (sql) =>
        proposeRecord(sql, { actor: hostile, resource: draftPatient(randomUUID()) })
      )
    );
    const proposer = await committed(practice, async (sql) => {
      const rows = await sql<{ proposer_actor_id: string }[]>`
        select proposer_actor_id from governance_proposal where id = ${record.proposalId}`;
      return rows[0]?.proposer_actor_id;
    });
    const trail = await auditTrail(practice);
    expect(trail.length).toBe(1);
    expect(trail[0]?.decision).toBe("allow");
    expect(trail[0]?.actor_id).toBe(proposer);
  });

  test("a cross-practice proposer is denied and the denial commits", async () => {
    const practice = randomUUID();
    const inner = await committed(practice, (sql) =>
      proposeRecord(sql, {
        actor: actorFor("agent", randomUUID()),
        resource: draftPatient(randomUUID())
      })
    );
    expect(errCode(inner)).toBe("GOVERNANCE_FORBIDDEN");
    const trail = await auditTrail(practice);
    expect(trail.length).toBe(1);
    expect(trail[0]?.decision).toBe("deny");
  });
});

describe("agent approve is denied and the denial is audited (acceptance #2/#5)", () => {
  test("deny commits ONE hash-chain-linked deny row; zero events; state unchanged", async () => {
    const practice = randomUUID();
    const agent = actorFor("agent", practice);
    const proposalId = await proposeDraft(practice, agent);

    const attempt = await committed(practice, (sql) =>
      approveProposal(sql, { actor: agent, proposalId })
    );
    expect(errCode(attempt)).toBe("GOVERNANCE_FORBIDDEN");

    const trail = await auditTrail(practice);
    expect(trail.length).toBe(2);
    const denial = trail[1];
    expect(denial?.decision).toBe("deny");
    expect(denial?.actor_id).toBe(agent.id);
    expect(denial?.resource_type).toBe("Governance.approve");
    expect(denial?.reason.length).toBeGreaterThan(0);

    expect((await eventRows(practice, proposalId)).length).toBe(0);
    // The deny row is a live link in the tamper-evident chain, not an orphan.
    const report = await committed(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.rows).toBe(2);

    // State unchanged: the clinician approve still succeeds from "proposed".
    const clinician = await committed(practice, (sql) =>
      approveProposal(sql, { actor: actorFor("clinician", practice), proposalId })
    );
    expect(unwrap(clinician).state).toBe("approved");
  });

  test("agent commit after clinician approval is still denied (deny row, no write)", async () => {
    const practice = randomUUID();
    const agent = actorFor("agent", practice);
    const proposalId = await proposeDraft(practice, agent);
    unwrap(
      await committed(practice, (sql) =>
        approveProposal(sql, { actor: actorFor("clinician", practice), proposalId })
      )
    );
    const attempt = await committed(practice, (sql) =>
      commitProposal(sql, { actor: agent, proposalId })
    );
    expect(errCode(attempt)).toBe("GOVERNANCE_FORBIDDEN");
    const trail = await auditTrail(practice);
    expect(trail.at(-1)?.decision).toBe("deny");
    expect(trail.at(-1)?.resource_type).toBe("Governance.commit");
    expect(await fhirCount(practice)).toBe(0);
  });

  test("biller AND agent are denied approve on the SAME proposal a clinician can approve", async () => {
    const practice = randomUUID();
    const proposalId = await proposeDraft(practice, actorFor("biller", practice));
    for (const role of ["biller", "agent"] as const) {
      const attempt = await committed(practice, (sql) =>
        approveProposal(sql, { actor: actorFor(role, practice), proposalId })
      );
      expect(errCode(attempt)).toBe("GOVERNANCE_FORBIDDEN");
    }
    const allow = await committed(practice, (sql) =>
      approveProposal(sql, { actor: actorFor("clinician", practice), proposalId })
    );
    expect(unwrap(allow).state).toBe("approved");
    // The approve event is chain-linked: its stored hash JOINs an allow row.
    const events = await eventRows(practice, proposalId);
    expect(events.length).toBe(1);
    const joined = await committed(practice, async (sql) => {
      const rows = await sql<{ decision: string; actor_id: string; resource_type: string }[]>`
        select decision, actor_id, resource_type from audit_log
        where row_hash = ${events[0]?.audit_row_hash ?? ""}`;
      return rows[0];
    });
    expect(joined?.decision).toBe("allow");
    expect(joined?.resource_type).toBe("Governance.approve");
    expect(joined?.actor_id).toBe(actorFor("clinician", practice).id);
  });
});

describe("deny commits as a VALUE; a DB fault rolls back (double-Result discipline)", () => {
  test("outer ok + inner err for a deny; outer err + nothing persisted for a throw", async () => {
    const practice = randomUUID();
    const denied = await db.withTenant(practice, (sql) =>
      approveProposal(sql, { actor: actorFor("agent", practice), proposalId: randomUUID() })
    );
    // Unknown proposal: typed NOT_FOUND, still an OUTER ok (nothing threw).
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(errCode(denied.data)).toBe("GOVERNANCE_NOT_FOUND");

    const faulted = await db.withTenant(practice, async (sql) => {
      unwrap(
        await proposeRecord(sql, {
          actor: actorFor("agent", practice),
          resource: draftPatient(randomUUID())
        })
      );
      throw new Error("forced post-propose fault");
    });
    expect(faulted.ok).toBe(false);
    // The fault rolled back BOTH the proposal and its allow audit row.
    expect((await auditTrail(practice)).length).toBe(0);
    expect(
      await countOf(practice, async (sql) => {
        const rows = await sql<{ n: number }[]>`select count(*)::int as n from governance_proposal`;
        return rows[0]?.n ?? -1;
      })
    ).toBe(0);
  });

  test("unknown proposal id and non-uuid id both -> GOVERNANCE_NOT_FOUND, zero rows", async () => {
    const practice = randomUUID();
    for (const proposalId of [randomUUID(), "definitely-not-a-uuid"]) {
      const attempt = await committed(practice, (sql) =>
        commitProposal(sql, { actor: actorFor("clinician", practice), proposalId })
      );
      expect(errCode(attempt)).toBe("GOVERNANCE_NOT_FOUND");
    }
    expect((await auditTrail(practice)).length).toBe(0);
  });
});

describe("illegal transitions are typed errs, UNAUDITED (acceptance #1/#8 Q4)", () => {
  test("clinician commit-before-approve -> GOVERNANCE_INVALID_TRANSITION, chain unchanged", async () => {
    const practice = randomUUID();
    const proposalId = await proposeDraft(practice, actorFor("agent", practice));
    const before = (await auditTrail(practice)).length;
    const attempt = await committed(practice, (sql) =>
      commitProposal(sql, { actor: actorFor("clinician", practice), proposalId })
    );
    expect(errCode(attempt)).toBe("GOVERNANCE_INVALID_TRANSITION");
    // A state error by an AUTHORIZED actor is not an authz decision: no audit
    // row, no event, no write.
    expect((await auditTrail(practice)).length).toBe(before);
    expect((await eventRows(practice, proposalId)).length).toBe(0);
    expect(await fhirCount(practice)).toBe(0);
  });

  test("double-approve -> GOVERNANCE_INVALID_TRANSITION, still exactly one approve event", async () => {
    const practice = randomUUID();
    const { clinician, proposalId } = await approvedDraft(practice);
    const again = await committed(practice, (sql) =>
      approveProposal(sql, { actor: clinician, proposalId })
    );
    expect(errCode(again)).toBe("GOVERNANCE_INVALID_TRANSITION");
    expect((await eventRows(practice, proposalId)).length).toBe(1);
  });
});

describe("full flow + immutability (acceptance #7/#8)", () => {
  test("propose(agent) -> approve(clinician) -> commit(clinician) -> signed note", async () => {
    const practice = randomUUID();
    const { clinician, proposalId } = await approvedDraft(practice);
    // fhir_resources gains its row ONLY at commit, never earlier.
    expect(await fhirCount(practice)).toBe(0);
    const note = unwrap(
      await committed(practice, (sql) => commitProposal(sql, { actor: clinician, proposalId }))
    );
    expect(await fhirCount(practice)).toBe(1);
    expect(signedNoteSchema.safeParse(note).success).toBe(true);
    expect(note.proposalId).toBe(proposalId);
    expect(note.approverActorId).toBe(clinician.id);
    expect(note.committerActorId).toBe(clinician.id);
    expect(note.resource.resourceType).toBe("Patient");

    // The signature: the note's hash JOINs the commit's allow row on the chain.
    const joined = await committed(practice, async (sql) => {
      const rows = await sql<{ decision: string; resource_type: string; actor_id: string }[]>`
        select decision, resource_type, actor_id from audit_log
        where row_hash = ${note.commitAuditHash}`;
      return rows[0];
    });
    expect(joined?.decision).toBe("allow");
    expect(joined?.resource_type).toBe("Governance.commit");
    expect(joined?.actor_id).toBe(clinician.id);

    const stored = await committed(practice, async (sql) => {
      const rows = await sql<{ commit_audit_hash: string; approver_actor_id: string }[]>`
        select commit_audit_hash, approver_actor_id from governance_signed_note
        where proposal_id = ${proposalId}`;
      return rows[0];
    });
    expect(stored?.commit_audit_hash).toBe(note.commitAuditHash);
    expect(stored?.approver_actor_id).toBe(clinician.id);
  });

  test("a duplicate-resource-id commit rolls back wholesale; first note + chain survive", async () => {
    // Q8 fail-closed: committing a second proposal that carries an already-live
    // resource id collides on the fhir_resources PK (23505) and THROWS, so the
    // whole tx rolls back. This pins that a throwing commit can never leave the
    // FHIR write live while dropping its governance event, and can't corrupt the
    // first committed note. A softened write (upsert / on-conflict / swallowed
    // throw) would break it.
    const practice = randomUUID();
    const clinician = actorFor("clinician", practice);
    const sharedId = randomUUID();

    const first = await approvedDraftFor(practice, sharedId);
    unwrap(
      await committed(practice, (sql) =>
        commitProposal(sql, { actor: clinician, proposalId: first })
      )
    );

    const second = await approvedDraftFor(practice, sharedId);
    const chainBefore = (await auditTrail(practice)).map((row) => row.row_hash);
    const fhirBefore = await fhirCount(practice);

    const faulted = await db.withTenant(practice, (sql) =>
      commitProposal(sql, { actor: clinician, proposalId: second })
    );
    expect(faulted.ok).toBe(false);
    if (!faulted.ok) expect(faulted.error.code).toBe("TENANT_TX_FAILED");

    // No trace: the allow row, commit event, signed note, AND the fhir write all
    // rolled back together; the first proposal's committed record is untouched.
    expect((await auditTrail(practice)).map((row) => row.row_hash)).toEqual(chainBefore);
    expect(await fhirCount(practice)).toBe(fhirBefore);
    expect(
      (await eventRows(practice, second)).filter((event) => event.action === "commit").length
    ).toBe(0);
    const report = await committed(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
  });

  test("after commit: re-approve and re-commit are typed errs, chain LITERALLY unchanged", async () => {
    const practice = randomUUID();
    const { clinician, proposalId } = await approvedDraft(practice);
    unwrap(
      await committed(practice, (sql) => commitProposal(sql, { actor: clinician, proposalId }))
    );
    const before = await auditTrail(practice);

    const reApprove = await committed(practice, (sql) =>
      approveProposal(sql, { actor: clinician, proposalId })
    );
    expect(errCode(reApprove)).toBe("GOVERNANCE_INVALID_TRANSITION");
    const reCommit = await committed(practice, (sql) =>
      commitProposal(sql, { actor: clinician, proposalId })
    );
    expect(errCode(reCommit)).toBe("GOVERNANCE_INVALID_TRANSITION");

    const after = await auditTrail(practice);
    expect(after.map((row) => row.row_hash)).toEqual(before.map((row) => row.row_hash));
    const events = await eventRows(practice, proposalId);
    expect(events.filter((event) => event.action === "commit").length).toBe(1);
    expect(await fhirCount(practice)).toBe(1);
    const report = await committed(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
  });
});
