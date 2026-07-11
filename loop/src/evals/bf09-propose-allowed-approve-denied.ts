/**
 * Execution eval bf09-propose-allowed-approve-denied (BF-09 acceptance #4 + #2;
 * danger: propose-only-broken).
 *
 * The BF-08 carry-over, driven through the BUILT product across the firewall:
 * a biller AND an agent can each PROPOSE (ok, state "proposed") for their own
 * fresh practice, and each is DENIED (GOVERNANCE_FORBIDDEN) approving their
 * own proposal; a clinician CAN approve both. Ground truth is read as the
 * OWNER (RLS-exempt): each propose wrote exactly one allow audit row
 * (Governance.propose), each self-approve deny wrote exactly one deny audit
 * row (Governance.approve) and ZERO governance events, and the clinician
 * approvals wrote exactly one approve event each (actor_role clinician). The
 * app (RLS) client bound to this practice sees both proposals; bound to a
 * foreign practice it sees none.
 *
 * Inversion: widening decideGovernance so a biller/agent approve matches a
 * rule (or gating propose on role) reddens it; so does dropping the deny
 * audit append or letting a denied approve insert a governance event.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Step, StepOutcome } from "./bf09-governance-util.js";
import {
  actorFor,
  clients,
  draftPatient,
  expectErr,
  expectOk,
  govern
} from "./bf09-governance-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf09-propose-allowed-approve-denied";

interface ActorRow {
  readonly actor_id: string;
}
interface EventRow {
  readonly proposal_id: string;
  readonly action: string;
  readonly actor_id: string;
  readonly actor_role: string;
}

const practice = randomUUID();
const biller = actorFor(randomUUID(), "biller", practice);
const agent = actorFor(randomUUID(), "agent", practice);
const clinician = actorFor(randomUUID(), "clinician", practice);
const nonClinicians = [biller, agent] as const;

function proposalIdOf(outcome: StepOutcome, label: string): string {
  const data = expectOk(EVAL_ID, outcome, label);
  if (typeof data.proposalId !== "string" || data.state !== "proposed") {
    fail(EVAL_ID, `${label}: expected {proposalId, state:"proposed"}, got ${JSON.stringify(data)}`);
  }
  return data.proposalId;
}

async function countProposals(sql: Sql, boundPractice: string): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${boundPractice}, true)`;
    const rows = await tx`select count(*)::int as n from governance_proposal
      where proposer_actor_id in ${tx(nonClinicians.map((actor) => actor.id))}`;
    return (rows[0] as { n: number } | undefined)?.n ?? -1;
  });
}

// PROPOSE: both non-clinician roles succeed (one withTenant tx per step).
const proposeSteps: Step[] = nonClinicians.map((actor) => ({
  op: "propose",
  actor,
  resource: draftPatient(randomUUID())
}));
const proposed = govern(EVAL_ID, practice, proposeSteps);
const [billerProposed, agentProposed] = proposed;
if (billerProposed === undefined || agentProposed === undefined) {
  fail(EVAL_ID, `expected ${String(proposeSteps.length)} propose outcomes`);
}
const billerProposal = proposalIdOf(billerProposed, "biller propose");
const agentProposal = proposalIdOf(agentProposed, "agent propose");

// APPROVE: each proposer is denied on its OWN proposal; the clinician
// is allowed on both.
const approveSteps: Step[] = [
  { op: "approve", actor: biller, proposalId: billerProposal },
  { op: "approve", actor: agent, proposalId: agentProposal },
  { op: "approve", actor: clinician, proposalId: billerProposal },
  { op: "approve", actor: clinician, proposalId: agentProposal }
];
const approved = govern(EVAL_ID, practice, approveSteps);
const [billerDenied, agentDenied, clinicianOnBiller, clinicianOnAgent] = approved;
if (
  billerDenied === undefined ||
  agentDenied === undefined ||
  clinicianOnBiller === undefined ||
  clinicianOnAgent === undefined
) {
  fail(EVAL_ID, `expected ${String(approveSteps.length)} approve outcomes`);
}
expectErr(EVAL_ID, billerDenied, "GOVERNANCE_FORBIDDEN", "biller approving own proposal");
expectErr(EVAL_ID, agentDenied, "GOVERNANCE_FORBIDDEN", "agent approving own proposal");
for (const [outcome, label] of [
  [clinicianOnBiller, "clinician approving biller proposal"],
  [clinicianOnAgent, "clinician approving agent proposal"]
] as const) {
  const data = expectOk(EVAL_ID, outcome, label);
  if (data.state !== "approved") fail(EVAL_ID, `${label}: state ${JSON.stringify(data.state)}`);
}

const { owner, app } = clients();
try {
  // Ground truth (owner, RLS-exempt): exactly one allow per propose, one deny
  // per blocked self-approve, and the denies wrote ZERO governance events.
  const proposeAllows = (await owner`select actor_id from audit_log
    where practice_id = ${practice} and decision = 'allow'
      and resource_type = 'Governance.propose' order by actor_id`) as unknown as ActorRow[];
  const expectedProposers = nonClinicians.map((actor) => actor.id).sort();
  if (proposeAllows.map((row) => row.actor_id).join(",") !== expectedProposers.join(",")) {
    fail(EVAL_ID, `propose allow rows wrong: ${JSON.stringify(proposeAllows)}`);
  }
  const approveDenies = (await owner`select actor_id from audit_log
    where practice_id = ${practice} and decision = 'deny'
      and resource_type = 'Governance.approve' order by actor_id`) as unknown as ActorRow[];
  if (approveDenies.map((row) => row.actor_id).join(",") !== expectedProposers.join(",")) {
    fail(EVAL_ID, `approve deny rows wrong: ${JSON.stringify(approveDenies)}`);
  }
  const events = (await owner`select
      proposal_id::text as proposal_id, action, actor_id, actor_role
    from governance_event where practice_id = ${practice}`) as unknown as EventRow[];
  if (
    events.length !== nonClinicians.length ||
    !events.every(
      (row) =>
        row.action === "approve" && row.actor_id === clinician.id && row.actor_role === "clinician"
    ) ||
    [...events.map((row) => row.proposal_id)].sort().join(",") !==
      [billerProposal, agentProposal].sort().join(",")
  ) {
    fail(EVAL_ID, `governance events wrong (denies must write none): ${JSON.stringify(events)}`);
  }

  // RLS posture (app client): own practice sees both proposals, a
  // foreign one sees zero.
  const own = await countProposals(app, practice);
  if (own !== nonClinicians.length) {
    fail(EVAL_ID, `app client bound to own practice saw ${String(own)} proposals`);
  }
  const foreign = await countProposals(app, randomUUID());
  if (foreign !== 0) {
    fail(EVAL_ID, `app client bound to a foreign practice saw ${String(foreign)} proposals (leak)`);
  }

  pass(
    EVAL_ID,
    "biller+agent propose ok; self-approve denied (audited deny, zero events); clinician approves both; RLS scopes proposals to own practice"
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
