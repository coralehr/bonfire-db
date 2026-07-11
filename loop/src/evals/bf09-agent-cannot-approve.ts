/**
 * Execution eval bf09-agent-cannot-approve (BF-09 acceptance #2; danger:
 * propose-only-broken).
 *
 * Driven through the BUILT product across the harness<->product firewall: an
 * AGENT stages a real proposal (propose is open to any role for its own
 * practice), then the SAME agent calls BOTH approve AND commit on it — each is
 * DENIED (GOVERNANCE_FORBIDDEN). The proposal's derived state is proven
 * UNCHANGED three ways, read as the OWNER (RLS-exempt ground truth):
 *   - ZERO governance_event rows exist for it after the two denied attempts;
 *   - NO fhir_resources row exists for the proposed resource id (honest
 *     staging: nothing reaches the clinical record before a clinician commit);
 *   - a SUBSEQUENT clinician approve then SUCCEEDS from "proposed" — it could
 *     only reach "approved" if the agent's calls left the state untouched.
 * The RLS app role, bound to this practice, also sees zero events (isolation).
 *
 * Inversion: soften decideGovernance so an agent's approve/commit matches a
 * rule (propose-only broken) -> the agent approve returns ok, a governance
 * event appears, and the later clinician approve becomes an INVALID_TRANSITION
 * -> RED. A commit that writes despite the deny -> the fhir_resources probe
 * finds the row -> RED.
 */
import { randomUUID } from "node:crypto";
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

const EVAL_ID = "bf09-agent-cannot-approve";
const FORBIDDEN = "GOVERNANCE_FORBIDDEN";

const practice = randomUUID();
const resourceId = randomUUID();
const agent = actorFor(randomUUID(), "agent", practice);
const clinician = actorFor(randomUUID(), "clinician", practice);

// 1) The agent stages a real proposal for a pinned resource id.
const proposalId = stageProposal(EVAL_ID, practice, agent, draftPatient(resourceId));

// 2) The SAME agent tries to approve AND commit its own proposal — both denied.
const attempts = govern(EVAL_ID, practice, [
  { op: "approve", actor: agent, proposalId },
  { op: "commit", actor: agent, proposalId }
]);
const [approveAttempt, commitAttempt] = attempts;
if (approveAttempt === undefined || commitAttempt === undefined) {
  fail(EVAL_ID, "expected agent approve+commit outcomes");
}
expectErr(EVAL_ID, approveAttempt, FORBIDDEN, "agent approve own proposal");
expectErr(EVAL_ID, commitAttempt, FORBIDDEN, "agent commit own proposal");

const { owner, app } = clients();
try {
  // Ground truth (owner, RLS-exempt): the two denied attempts advanced NOTHING.
  const eventRows = await owner`select count(*)::int as n from governance_event
    where practice_id = ${practice} and proposal_id = ${proposalId}`;
  const eventCount = (eventRows[0] as { n: number } | undefined)?.n ?? -1;
  if (eventCount !== 0) {
    fail(EVAL_ID, `agent denials left ${String(eventCount)} governance_event rows, expected 0`);
  }
  // Honest staging: no clinical record exists for the still-uncommitted resource.
  const fhirRows = await owner`select count(*)::int as n from fhir_resources
    where id = ${resourceId}`;
  const fhirCount = (fhirRows[0] as { n: number } | undefined)?.n ?? -1;
  if (fhirCount !== 0) {
    fail(
      EVAL_ID,
      `honest-staging breach: ${String(fhirCount)} fhir_resources rows for an uncommitted resource`
    );
  }
  // The RLS app role, bound to this practice, ALSO sees no event (isolation intact).
  const appEvents = await app.begin(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${practice}, true)`;
    const rows = await tx`select count(*)::int as n from governance_event
      where proposal_id = ${proposalId}`;
    return (rows[0] as { n: number } | undefined)?.n ?? -1;
  });
  if (appEvents !== 0) {
    fail(EVAL_ID, `RLS app role saw ${String(appEvents)} events for an unadvanced proposal`);
  }

  // 3) State was UNCHANGED (still "proposed"): a clinician approve now succeeds.
  const approved = govern(EVAL_ID, practice, [{ op: "approve", actor: clinician, proposalId }]);
  const approvedOutcome = approved[0];
  if (approvedOutcome === undefined) fail(EVAL_ID, "no clinician approve outcome");
  const record = expectOk(EVAL_ID, approvedOutcome, "clinician approve");
  if (record.state !== "approved") {
    fail(EVAL_ID, `clinician approve state ${JSON.stringify(record.state)}, expected approved`);
  }

  pass(
    EVAL_ID,
    "agent approve+commit both FORBIDDEN; 0 governance events, 0 fhir rows; clinician then approves from the unchanged proposed state"
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
