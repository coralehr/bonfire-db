/**
 * Governance transactional layer (BF-09). Every function runs INSIDE a
 * withTenant transaction and obeys the audit contract: exactly ZERO or ONE
 * audit row per attempt, appended via appendAuditRowTx (the audit public API)
 * only once the final outcome is known, immediately before the mutation
 * inserts. A denial is returned as an err VALUE so withTenant COMMITS the deny
 * row with zero mutations; a database fault THROWS so the whole transaction —
 * including any audit row — rolls back. An illegal transition by an AUTHORIZED
 * actor is a state error, not an authz decision: typed err, unaudited, zero
 * rows, so a re-commit attempt leaves the chain literally unchanged.
 *
 * Lock ordering invariant (deadlock-free by construction): approve/commit take
 * the per-practice GOVERNANCE advisory lock first (inside loadProposal), then
 * the audit chain's per-practice lock inside appendAuditRowTx. propose takes
 * only the audit lock. No code path acquires the two in reverse order.
 */
import { z } from "zod";
import type { PolicyReceipt } from "../abac/types.js";
import { appendAuditRowTx } from "../audit/audit-log.js";
import type { TenantSql } from "../db/tenant.js";
import { toJsonObject } from "../fhir/json.js";
import { scribeInputSchema } from "../fhir/scribe-schemas.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import type { WriteError } from "../write/errors.js";
import { writeScribeResource } from "../write/write-resource.js";
import { decideGovernance, transition } from "./policy.js";
import type {
  GovernanceActor,
  GovernanceError,
  GovernanceState,
  ProposalRecord,
  SignedNote
} from "./types.js";
import { governanceActorSchema, signedNoteSchema } from "./types.js";

const uuidSchema = z.uuid();
const practiceRowSchema = z.object({ practice_id: z.string() });
const insertedIdRowSchema = z.object({ id: z.string() });
const proposalRowSchema = z.object({ resource: z.unknown() });
const eventRowSchema = z.object({
  action: z.enum(["approve", "commit"]),
  actor_id: z.string(),
  occurred_at: z.string()
});

const NOT_FOUND: GovernanceError = {
  code: "GOVERNANCE_NOT_FOUND",
  message: "no such proposal in this practice"
};

interface LoadedProposal {
  readonly resource: unknown;
  readonly state: GovernanceState;
  readonly approveEvent: z.infer<typeof eventRowSchema> | undefined;
}

interface AllowedAttempt {
  readonly receipt: PolicyReceipt;
  readonly actor: GovernanceActor;
}

/** The transaction's bound practice, read from the tenant GUC — never caller input. */
async function boundPracticeId(sql: TenantSql): Promise<string> {
  const rows = await sql`
    select (select safe_uuid(current_setting('app.current_practice_id', true)))::text as practice_id`;
  const parsed = practiceRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error("governance requires a bound practice context");
  return parsed.data.practice_id;
}

/** Parse the untrusted actor to a snapshot ONCE; a thrown getter yields undefined (→ deny). */
function snapshotActor(rawActor: unknown): GovernanceActor | undefined {
  try {
    const parsed = governanceActorSchema.safeParse(rawActor);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide + audit one governance attempt. The untrusted actor is read exactly
 * ONCE into a frozen snapshot: that snapshot is both what the decision is
 * attributed to AND what the caller records in the event/signed note, so a
 * value-shifting getter cannot make the audit chain and the governance state
 * disagree on who acted (the audit_row_hash JOIN only means anything while
 * audit-actor === state-actor). A deny appends the deny receipt and returns
 * err — a VALUE, so the deny row commits with zero mutations. An allow returns
 * the receipt UNAPPENDED: the caller appends it immediately before its own
 * mutation inserts (the zero-or-one-row contract).
 */
async function authorizeAttempt(
  sql: TenantSql,
  rawActor: unknown,
  action: "propose" | "approve" | "commit"
): Promise<Result<AllowedAttempt, GovernanceError>> {
  const practice = await boundPracticeId(sql);
  // A snapshot that fails to build (invalid, or a getter that throws) is left as
  // the raw value for decideGovernance to resolve to its malformed-deny receipt.
  const snapshot = snapshotActor(rawActor);
  const receipt = decideGovernance({
    actor: snapshot ?? rawActor,
    action,
    boundPracticeId: practice
  });
  if (receipt.decision === "deny") {
    await appendAuditRowTx(sql, receipt);
    return err({ code: "GOVERNANCE_FORBIDDEN", message: receipt.reason });
  }
  // An allow is unreachable unless the snapshot parsed — decideGovernance denies
  // everything it cannot parse — so the event records the audited identity.
  if (snapshot === undefined) throw new Error("governance allow without a parsed actor");
  return ok({ receipt, actor: snapshot });
}

async function insertEvent(
  sql: TenantSql,
  event: {
    readonly proposalId: string;
    readonly action: "approve" | "commit";
    readonly actor: GovernanceActor;
    readonly auditRowHash: string;
    readonly occurredAt: string;
  }
): Promise<void> {
  await sql`
    insert into governance_event
      (practice_id, proposal_id, action, actor_id, actor_role, audit_row_hash, occurred_at)
    values ((select safe_uuid(current_setting('app.current_practice_id', true))),
      ${event.proposalId}, ${event.action}, ${event.actor.id}, ${event.actor.role},
      ${event.auditRowHash}, ${event.occurredAt}::timestamptz)`;
}

/**
 * Lock, load, and derive. The per-practice governance advisory lock is taken
 * BEFORE the read so concurrent approve/commit for one practice serialize
 * (governance lock first, audit chain lock second — fixed order, no deadlock);
 * the key is GUC-sourced, never a client-influenceable value. State derives
 * from events (the tables have no update path): commit → committed, approve →
 * approved, none → proposed.
 */
async function loadProposal(sql: TenantSql, proposalId: string): Promise<LoadedProposal | null> {
  await sql`select pg_advisory_xact_lock(hashtext('bonfire.governance'),
    hashtext(coalesce(current_setting('app.current_practice_id', true), '')))`;
  const proposals = await sql`
    select resource from governance_proposal where id = ${proposalId}`;
  if (proposals.length === 0) return null;
  const proposal = proposalRowSchema.safeParse(proposals[0]);
  if (!proposal.success) throw new Error("unexpected governance_proposal row shape");
  const eventRows = await sql`
    select action, actor_id, occurred_at::text as occurred_at
    from governance_event where proposal_id = ${proposalId}`;
  const events = eventRows.map((row) => {
    const parsed = eventRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("unexpected governance_event row shape");
    return parsed.data;
  });
  const approveEvent = events.find((event) => event.action === "approve");
  const commitEvent = events.find((event) => event.action === "commit");
  if (commitEvent !== undefined && approveEvent === undefined) {
    // Unreachable through transition(); its presence means the event log
    // itself is corrupt, which must fail LOUD rather than derive a state.
    throw new Error("governance event log corrupt: commit event without approve");
  }
  let state: GovernanceState = "proposed";
  if (commitEvent !== undefined) state = "committed";
  else if (approveEvent !== undefined) state = "approved";
  return { resource: proposal.data.resource, state, approveEvent };
}

/**
 * Stage a resource for clinician review. Any governance role (including the
 * agent) may propose for its own practice. The resource is validated against
 * the scribe boundary schema and staged in governance_proposal ONLY — no
 * fhir_resources row exists until a clinician-approved commit (honest staging).
 */
export async function proposeRecord(
  sql: TenantSql,
  input: { readonly actor: unknown; readonly resource: unknown }
): Promise<Result<ProposalRecord, GovernanceError | WriteError>> {
  const resource = scribeInputSchema.safeParse(input.resource);
  if (!resource.success) {
    // A malformed resource is a validation failure, not a governance decision:
    // zero audit rows (the zero-or-one contract counts decisions, not typos).
    return err({ code: "INVALID_SCRIBE_INPUT", message: "invalid proposal resource" });
  }
  const attempt = await authorizeAttempt(sql, input.actor, "propose");
  if (!attempt.ok) return attempt;
  await appendAuditRowTx(sql, attempt.data.receipt);
  const inserted = await sql`
    insert into governance_proposal (practice_id, proposer_actor_id, proposer_role, resource)
    values ((select safe_uuid(current_setting('app.current_practice_id', true))),
      ${attempt.data.actor.id}, ${attempt.data.actor.role}, ${sql.json(toJsonObject(resource.data))})
    returning id::text as id`;
  const row = insertedIdRowSchema.safeParse(inserted[0]);
  if (!row.success) throw new Error("unexpected governance_proposal insert row shape");
  const record: ProposalRecord = { proposalId: row.data.id, state: "proposed" };
  return ok(record);
}

/**
 * The shared approve/commit seam: validate the id, lock + load + derive state,
 * authorize (deny → audited err), check the transition (illegal → typed err,
 * UNAUDITED, zero rows), then run the action-specific mutation.
 */
async function advance<T>(
  sql: TenantSql,
  input: { readonly actor: unknown; readonly proposalId: string },
  action: "approve" | "commit",
  onAllowed: (
    allowed: AllowedAttempt,
    loaded: LoadedProposal
  ) => Promise<Result<T, GovernanceError | WriteError>>
): Promise<Result<T, GovernanceError | WriteError>> {
  if (!uuidSchema.safeParse(input.proposalId).success) return err(NOT_FOUND);
  const loaded = await loadProposal(sql, input.proposalId);
  if (loaded === null) return err(NOT_FOUND);
  const attempt = await authorizeAttempt(sql, input.actor, action);
  if (!attempt.ok) return attempt;
  const next = transition(loaded.state, action);
  if (!next.ok) return next;
  return onAllowed(attempt.data, loaded);
}

/** Clinician-only: advance a proposed record to approved (allow row + approve event). */
export function approveProposal(
  sql: TenantSql,
  input: { readonly actor: unknown; readonly proposalId: string }
): Promise<Result<ProposalRecord, GovernanceError | WriteError>> {
  return advance(sql, input, "approve", async ({ receipt, actor }) => {
    const { auditRowHash } = await appendAuditRowTx(sql, receipt);
    await insertEvent(sql, {
      proposalId: input.proposalId,
      action: "approve",
      actor,
      auditRowHash,
      occurredAt: receipt.timestamp
    });
    const record: ProposalRecord = { proposalId: input.proposalId, state: "approved" };
    return ok(record);
  });
}

/**
 * Clinician-only: commit an APPROVED proposal — write the canonical FHIR via
 * the one typed write path, then bind the commit to the audit chain (allow row
 * + commit event + signed note) in the same transaction. A write-layer err
 * passes through with zero audit rows (a failed attempt leaves no trace); a
 * throw (e.g. a duplicate resource id) rolls the whole transaction back.
 */
export function commitProposal(
  sql: TenantSql,
  input: { readonly actor: unknown; readonly proposalId: string }
): Promise<Result<SignedNote, GovernanceError | WriteError>> {
  return advance(sql, input, "commit", async ({ receipt, actor }, loaded) => {
    const written = await writeScribeResource(sql, loaded.resource);
    if (!written.ok) return written;
    const approveEvent = loaded.approveEvent;
    if (approveEvent === undefined) throw new Error("commit allowed without an approve event");
    const { auditRowHash } = await appendAuditRowTx(sql, receipt);
    await insertEvent(sql, {
      proposalId: input.proposalId,
      action: "commit",
      actor,
      auditRowHash,
      occurredAt: receipt.timestamp
    });
    const note: SignedNote = {
      proposalId: input.proposalId,
      resource: {
        resourceType: written.data.record.type,
        resourceId: written.data.record.id,
        versionId: written.data.record.versionId
      },
      approverActorId: approveEvent.actor_id,
      approvedAt: approveEvent.occurred_at,
      committerActorId: actor.id,
      signedAt: receipt.timestamp,
      commitAuditHash: auditRowHash
    };
    await sql`
      insert into governance_signed_note
        (practice_id, proposal_id, fhir_resource_type, fhir_resource_id, fhir_version_id,
         approver_actor_id, approved_at, committer_actor_id, signed_at, commit_audit_hash)
      values ((select safe_uuid(current_setting('app.current_practice_id', true))),
        ${note.proposalId}, ${note.resource.resourceType}, ${note.resource.resourceId},
        ${note.resource.versionId}, ${note.approverActorId}, ${note.approvedAt}::timestamptz,
        ${note.committerActorId}, ${note.signedAt}::timestamptz, ${note.commitAuditHash})`;
    return ok(signedNoteSchema.parse(note));
  });
}
