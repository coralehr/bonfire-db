/**
 * Execution eval bf09-governance-denial-audited (BF-09 acceptance #5; danger:
 * audit-bypass).
 *
 * A blocked governance decision is TAMPER-EVIDENTLY audited, never silently
 * dropped. An agent stages a proposal (allow), its own approve is denied
 * (deny), then a clinician approves (allow). Read as the OWNER (RLS-exempt),
 * this practice's WHOLE audit chain re-verifies structurally: row 0 links from
 * the pinned genesis prev_hash (recomputed here at runtime), every later row's
 * prev_hash equals its predecessor's row_hash, and seq increments by one — so
 * the deny row is a LIVE link, not an orphan. Exactly ONE deny row exists
 * (actor = the agent id, resource_type Governance.approve, nonempty reason).
 * Finally the approve event's stored audit_row_hash JOINs an audit_log row with
 * decision=allow and resource_type=Governance.approve: the hash column is
 * load-bearing linkage, not decoration.
 *
 * Inversion: dropping the deny append (audit-bypass) empties the deny set ->
 * RED; pointing a governance event's audit_row_hash at the wrong (e.g. deny)
 * row breaks the JOIN's decision/resource_type -> RED; breaking a prev_hash
 * link or seq step fails the chain walk -> RED.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import {
  actorFor,
  clients,
  draftPatient,
  expectErr,
  expectOk,
  govern
} from "./bf09-governance-util.js";
import { stageProposal } from "./bf09-stage.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf09-governance-denial-audited";
/** Recompute the per-practice genesis prev_hash at runtime — never hardcode the digest. */
const GENESIS_DOMAIN = "bonfire.audit.v1.genesis";
const GENESIS_PREV_HASH = createHash("sha256")
  .update(JSON.stringify({ domain: GENESIS_DOMAIN }))
  .digest("hex");

interface ChainRow {
  readonly seq: string;
  readonly prev_hash: string;
  readonly row_hash: string;
  readonly decision: string;
  readonly actor_id: string;
  readonly resource_type: string;
  readonly reason: string;
}

interface JoinedRow {
  readonly decision: string;
  readonly resource_type: string;
  readonly actor_id: string;
}

/** JOIN the approve event's stored hash back to its audit row (the linkage claim). */
async function joinApproveEventHash(
  owner: Sql,
  practice: string,
  proposalId: string
): Promise<JoinedRow | undefined> {
  const rows = await owner`select a.decision, a.resource_type, a.actor_id
    from governance_event g join audit_log a
      on a.practice_id = g.practice_id and a.row_hash = g.audit_row_hash
    where g.practice_id = ${practice} and g.proposal_id = ${proposalId} and g.action = 'approve'`;
  return rows[0] as JoinedRow | undefined;
}

const practice = randomUUID();
const agent = actorFor(randomUUID(), "agent", practice);
const clinician = actorFor(randomUUID(), "clinician", practice);

// propose(agent, allow) -> agent self-approve (DENY) -> clinician approve (allow).
const proposalId = stageProposal(EVAL_ID, practice, agent, draftPatient(randomUUID()));

const advanced = govern(EVAL_ID, practice, [
  { op: "approve", actor: agent, proposalId },
  { op: "approve", actor: clinician, proposalId }
]);
const [agentApprove, clinicianApprove] = advanced;
if (agentApprove === undefined || clinicianApprove === undefined) {
  fail(EVAL_ID, "expected agent+clinician approve outcomes");
}
expectErr(EVAL_ID, agentApprove, "GOVERNANCE_FORBIDDEN", "agent self-approve");
if (expectOk(EVAL_ID, clinicianApprove, "clinician approve").state !== "approved") {
  fail(EVAL_ID, "clinician approve did not reach approved");
}

const { owner, app } = clients();
try {
  const chain = (await owner`select seq::text as seq, prev_hash, row_hash, decision,
    actor_id, resource_type, reason from audit_log
    where practice_id = ${practice} order by audit_log.seq asc`) as unknown as ChainRow[];

  // Re-verify structurally: genesis link, prev_hash == predecessor row_hash, seq += 1.
  let expectedSeq = 1;
  let prev = GENESIS_PREV_HASH;
  for (const row of chain) {
    if (row.prev_hash !== prev) {
      fail(EVAL_ID, `chain break at seq ${row.seq}: prev_hash ${row.prev_hash} != ${prev}`);
    }
    if (Number(row.seq) !== expectedSeq) {
      fail(EVAL_ID, `seq gap: got ${row.seq}, expected ${String(expectedSeq)}`);
    }
    prev = row.row_hash;
    expectedSeq += 1;
  }

  // Exactly ONE deny row, attributed to the agent, for the blocked approve.
  const denies = chain.filter((row) => row.decision === "deny");
  const deny = denies[0];
  if (denies.length !== 1 || deny === undefined) {
    fail(EVAL_ID, `expected exactly one deny row, got ${String(denies.length)}`);
  }
  if (
    deny.actor_id !== agent.id ||
    deny.resource_type !== "Governance.approve" ||
    deny.reason.length === 0
  ) {
    fail(EVAL_ID, `deny row wrong: ${JSON.stringify(deny)}`);
  }

  // The approve event's stored hash is load-bearing: it JOINs an ALLOW row.
  const joined = await joinApproveEventHash(owner, practice, proposalId);
  if (joined === undefined) fail(EVAL_ID, "approve event hash JOINed no audit row");
  if (
    joined.decision !== "allow" ||
    joined.resource_type !== "Governance.approve" ||
    joined.actor_id !== clinician.id
  ) {
    fail(EVAL_ID, `approve event hash JOINed the wrong row: ${JSON.stringify(joined)}`);
  }

  pass(
    EVAL_ID,
    `chain re-verified from genesis (${String(chain.length)} rows); exactly one deny (agent, Governance.approve, reason set); approve event hash JOINs its allow row`
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
