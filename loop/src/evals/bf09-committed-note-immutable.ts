/**
 * Execution eval bf09-committed-note-immutable (BF-09 acceptance #7/#8; danger:
 * propose-only-broken + immutability).
 *
 * Drive a full propose(agent) -> approve(clinician) -> commit(clinician) to a
 * signed note across the harness<->product firewall, then attack the committed
 * record:
 *   - re-approve AND re-commit the committed proposal both return
 *     GOVERNANCE_INVALID_TRANSITION (a state error by an AUTHORIZED actor);
 *   - those two failed attempts are UNAUDITED (Q4) — the practice's audit chain
 *     length is LITERALLY unchanged by them;
 *   - exactly ONE commit governance_event exists and the signed-note ROW is
 *     byte-for-byte unchanged (full to_jsonb snapshot before/after); and
 *   - the RLS app role, even bound to this practice, cannot UPDATE or DELETE a
 *     governance_signed_note row (42501) — immutability is a privilege-layer
 *     guarantee (GRANT SELECT,INSERT only), not merely app logic.
 *
 * Inversion: a softened transition / UPDATE path that let a re-commit mutate
 * state grows the commit-event count or the audit chain, or changes the note ->
 * RED; a GRANT of UPDATE/DELETE on governance_signed_note drops the 42501 -> RED.
 */
import { randomUUID } from "node:crypto";
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

const EVAL_ID = "bf09-committed-note-immutable";
const INVALID = "GOVERNANCE_INVALID_TRANSITION";
const APP_INSUFFICIENT_PRIVILEGE = "42501";
/** The app role is GRANTed SELECT,INSERT only; each of these must be refused. */
const NOTE_MUTATIONS = [
  "update governance_signed_note set committer_actor_id = committer_actor_id",
  "delete from governance_signed_note"
] as const;

const practice = randomUUID();
const agent = actorFor(randomUUID(), "agent", practice);
const clinician = actorFor(randomUUID(), "clinician", practice);

async function auditChainLength(owner: Sql): Promise<number> {
  const rows =
    await owner`select count(*)::int as n from audit_log where practice_id = ${practice}`;
  return (rows[0] as { n: number } | undefined)?.n ?? -1;
}

/** The full signed-note row serialized to canonical text (id + every column). */
async function noteSnapshot(owner: Sql, proposalId: string): Promise<string> {
  const rows = await owner`select to_jsonb(g.*)::text as snap from governance_signed_note g
    where g.practice_id = ${practice} and g.proposal_id = ${proposalId}`;
  const snap = (rows[0] as { snap: string } | undefined)?.snap;
  if (snap === undefined) fail(EVAL_ID, "no signed note row after commit");
  return snap;
}

/** Run a forbidden write as the RLS app role; return the SQLSTATE it raised. */
async function forbiddenWrite(app: Sql, statement: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${practice}, true)`;
      await tx.unsafe(statement);
    });
    return "no-error";
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

// propose(agent) -> approve(clinician) -> commit(clinician): the full happy path.
const proposalId = stageProposal(EVAL_ID, practice, agent, draftPatient(randomUUID()));

const committed = govern(EVAL_ID, practice, [
  { op: "approve", actor: clinician, proposalId },
  { op: "commit", actor: clinician, proposalId }
]);
const [approveOutcome, commitOutcome] = committed;
if (approveOutcome === undefined || commitOutcome === undefined) {
  fail(EVAL_ID, "expected approve+commit outcomes");
}
expectOk(EVAL_ID, approveOutcome, "clinician approve");
const note = expectOk(EVAL_ID, commitOutcome, "clinician commit");
if (note.proposalId !== proposalId) {
  fail(EVAL_ID, `signed note proposalId ${JSON.stringify(note.proposalId)} != ${proposalId}`);
}

const { owner, app } = clients();
try {
  const lengthAfterCommit = await auditChainLength(owner);
  const noteAfterCommit = await noteSnapshot(owner, proposalId);

  // Attack: re-approve and re-commit the COMMITTED proposal — both illegal.
  const replays = govern(EVAL_ID, practice, [
    { op: "approve", actor: clinician, proposalId },
    { op: "commit", actor: clinician, proposalId }
  ]);
  const [reApprove, reCommit] = replays;
  if (reApprove === undefined || reCommit === undefined) {
    fail(EVAL_ID, "expected re-approve+re-commit outcomes");
  }
  expectErr(EVAL_ID, reApprove, INVALID, "re-approve committed proposal");
  expectErr(EVAL_ID, reCommit, INVALID, "re-commit committed proposal");

  // Illegal transitions by an authorized actor are UNAUDITED: chain unchanged.
  const lengthAfterReplays = await auditChainLength(owner);
  if (lengthAfterReplays !== lengthAfterCommit) {
    fail(
      EVAL_ID,
      `audit chain grew ${String(lengthAfterCommit)} -> ${String(lengthAfterReplays)} on illegal transitions`
    );
  }
  // Exactly ONE commit event; the signed-note row is byte-for-byte unchanged.
  const commitEvents = await owner`select count(*)::int as n from governance_event
    where practice_id = ${practice} and proposal_id = ${proposalId} and action = 'commit'`;
  const commitEventCount = (commitEvents[0] as { n: number } | undefined)?.n ?? -1;
  if (commitEventCount !== 1) {
    fail(EVAL_ID, `expected exactly one commit event, got ${String(commitEventCount)}`);
  }
  if ((await noteSnapshot(owner, proposalId)) !== noteAfterCommit) {
    fail(EVAL_ID, "signed note row changed after the failed replay attempts");
  }

  // Immutability at the privilege layer: the app role cannot UPDATE or DELETE.
  for (const statement of NOTE_MUTATIONS) {
    const code = await forbiddenWrite(app, statement);
    if (code !== APP_INSUFFICIENT_PRIVILEGE) {
      fail(EVAL_ID, `app "${statement}" returned ${code}, expected ${APP_INSUFFICIENT_PRIVILEGE}`);
    }
  }

  pass(
    EVAL_ID,
    "commit -> signed note; re-approve+re-commit both INVALID_TRANSITION and UNAUDITED (audit chain + note unchanged, one commit event); app UPDATE/DELETE on the note -> 42501"
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
