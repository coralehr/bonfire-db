/**
 * Execution eval bf09-clinician-only-approval (BF-09 acceptance #3; danger:
 * fail-open-authz).
 *
 * Across every non-clinician governance role — biller, operations, researcher,
 * agent — approve on a real proposal is DENIED (GOVERNANCE_FORBIDDEN), and a
 * MALFORMED actor (role missing) is also denied; only the clinician approve
 * succeeds. Because the clinician approve runs LAST and succeeds from
 * "proposed", the denials provably left the state unchanged. Ground truth is
 * read as the OWNER: exactly one Governance.approve deny row per denied role
 * (actor set matches), exactly one malformed-deny sentinel row (actor_id
 * "unknown", resource_type "unknown") on THIS practice's chain, exactly one
 * Governance.approve allow row (matched_rule_id bf09-approve-clinician), and
 * exactly one approve event whose audit_row_hash equals that allow row's
 * row_hash (the event is bound to the tamper-evident chain).
 *
 * Inversion: widening the approve rule in decideGovernance to any role (or
 * letting a parse failure fall through to allow) reddens it; so does breaking
 * the allow-row/event hash binding.
 */
import { randomUUID } from "node:crypto";
import type { Step } from "./bf09-governance-util.js";
import {
  actorFor,
  clients,
  draftPatient,
  expectErr,
  expectOk,
  govern
} from "./bf09-governance-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf09-clinician-only-approval";

interface DenyRow {
  readonly actor_id: string;
  readonly resource_type: string;
}
interface AllowRow {
  readonly actor_id: string;
  readonly matched_rule_id: string | null;
  readonly row_hash: string;
}
interface EventRow {
  readonly action: string;
  readonly actor_id: string;
  readonly actor_role: string;
  readonly audit_row_hash: string;
}

const practice = randomUUID();
const deniedActors = (["biller", "operations", "researcher", "agent"] as const).map((role) =>
  actorFor(randomUUID(), role, practice)
);
const clinician = actorFor(randomUUID(), "clinician", practice);
/** Missing role: fails the actor parse, must resolve to the malformed deny. */
const malformedActor = { id: randomUUID(), practiceId: practice };

// PROPOSE (agent — any role may) then the approve gauntlet, one tx per step.
const proposedOutcomes = govern(EVAL_ID, practice, [
  {
    op: "propose",
    actor: actorFor(randomUUID(), "agent", practice),
    resource: draftPatient(randomUUID())
  }
]);
const proposeOutcome = proposedOutcomes[0];
if (proposeOutcome === undefined) fail(EVAL_ID, "no propose outcome");
const proposeData = expectOk(EVAL_ID, proposeOutcome, "agent propose");
const proposalId = proposeData.proposalId;
if (typeof proposalId !== "string") fail(EVAL_ID, "propose returned no proposalId");

const approveSteps: Step[] = [
  ...deniedActors.map((actor): Step => ({ op: "approve", actor, proposalId })),
  { op: "approve", actor: malformedActor, proposalId },
  { op: "approve", actor: clinician, proposalId }
];
const outcomes = govern(EVAL_ID, practice, approveSteps);
if (outcomes.length !== approveSteps.length) {
  fail(EVAL_ID, `expected ${String(approveSteps.length)} outcomes, got ${String(outcomes.length)}`);
}
deniedActors.forEach((actor, index) => {
  const outcome = outcomes[index];
  if (outcome === undefined) fail(EVAL_ID, `missing outcome for role ${actor.role}`);
  expectErr(EVAL_ID, outcome, "GOVERNANCE_FORBIDDEN", `approve as ${actor.role}`);
});
const malformedOutcome = outcomes[deniedActors.length];
if (malformedOutcome === undefined) fail(EVAL_ID, "missing malformed-actor outcome");
expectErr(EVAL_ID, malformedOutcome, "GOVERNANCE_FORBIDDEN", "approve as malformed actor");
const clinicianOutcome = outcomes[outcomes.length - 1];
if (clinicianOutcome === undefined) fail(EVAL_ID, "missing clinician outcome");
const clinicianData = expectOk(EVAL_ID, clinicianOutcome, "clinician approve");
if (clinicianData.state !== "approved") {
  fail(EVAL_ID, `clinician approve state ${JSON.stringify(clinicianData.state)}`);
}

// app client unused here (RLS posture is proven by the sibling
// bf09-propose-allowed-approve-denied) but must still be closed.
const { owner, app } = clients();
try {
  // One deny row per denied ROLE, attributed to the right actor.
  const roleDenies = (await owner`select actor_id, resource_type from audit_log
    where practice_id = ${practice} and decision = 'deny'
      and resource_type = 'Governance.approve' order by actor_id`) as unknown as DenyRow[];
  const expectedDenied = deniedActors.map((actor) => actor.id).sort();
  if (roleDenies.map((row) => row.actor_id).join(",") !== expectedDenied.join(",")) {
    fail(EVAL_ID, `role deny rows wrong: ${JSON.stringify(roleDenies)}`);
  }
  // Exactly one malformed-deny sentinel row on THIS practice's chain.
  const malformedDenies = (await owner`select actor_id, resource_type from audit_log
    where practice_id = ${practice} and decision = 'deny'
      and actor_id = 'unknown'`) as unknown as DenyRow[];
  const malformedRow = malformedDenies[0];
  if (malformedDenies.length !== 1 || malformedRow?.resource_type !== "unknown") {
    fail(EVAL_ID, `malformed-actor deny rows wrong: ${JSON.stringify(malformedDenies)}`);
  }
  // Exactly one approve ALLOW row, matched by the clinician rule.
  const allows = (await owner`select actor_id, matched_rule_id, row_hash from audit_log
    where practice_id = ${practice} and decision = 'allow'
      and resource_type = 'Governance.approve'`) as unknown as AllowRow[];
  const allowRow = allows[0];
  if (
    allows.length !== 1 ||
    allowRow?.actor_id !== clinician.id ||
    allowRow.matched_rule_id !== "bf09-approve-clinician"
  ) {
    fail(EVAL_ID, `approve allow rows wrong: ${JSON.stringify(allows)}`);
  }
  // Exactly one approve event, clinician-attributed, bound to that
  // allow row's hash.
  const events = (await owner`select action, actor_id, actor_role, audit_row_hash
    from governance_event where practice_id = ${practice}
      and proposal_id = ${proposalId}`) as unknown as EventRow[];
  const eventRow = events[0];
  if (
    events.length !== 1 ||
    eventRow?.action !== "approve" ||
    eventRow.actor_id !== clinician.id ||
    eventRow.actor_role !== "clinician" ||
    eventRow.audit_row_hash !== allowRow.row_hash
  ) {
    fail(EVAL_ID, `approve events wrong (denies must write none): ${JSON.stringify(events)}`);
  }

  pass(
    EVAL_ID,
    `${String(deniedActors.length)} roles + malformed actor denied (each audited, zero events); clinician approve allowed from proposed, event bound to allow row_hash`
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
