/**
 * Governance boundary types (BF-09). The governance role set extends the ABAC
 * ROLES with "agent" — the autonomous actor that may PROPOSE but never
 * approve or commit. "rejected" exists only in the pure state machine (no
 * persistence path ships in v0), and the signed note is the boundary Zod
 * schema for the immutable committed record: its commitAuditHash IS the
 * signature, binding the note to the BF-05 tamper-evident audit chain.
 */
import { z } from "zod";
import { ROLES } from "../abac/types.js";
import type { BonfireError } from "../result.js";

/** The ABAC role set plus the autonomous agent (propose-only). */
export const GOVERNANCE_ROLES = [...ROLES, "agent"] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

/** Untrusted actor boundary: parsed before any governance rule sees it. */
export const governanceActorSchema = z.object({
  id: z.string().min(1),
  role: z.enum(GOVERNANCE_ROLES),
  practiceId: z.uuid()
});
export type GovernanceActor = z.infer<typeof governanceActorSchema>;

export const GOVERNANCE_STATES = ["proposed", "approved", "committed", "rejected"] as const;
export type GovernanceState = (typeof GOVERNANCE_STATES)[number];

export const GOVERNANCE_ACTIONS = ["propose", "approve", "commit", "reject"] as const;
export type GovernanceAction = (typeof GOVERNANCE_ACTIONS)[number];

export type GovernanceErrorCode =
  | "GOVERNANCE_FORBIDDEN"
  | "GOVERNANCE_INVALID_TRANSITION"
  | "GOVERNANCE_NOT_FOUND";
export type GovernanceError = BonfireError<GovernanceErrorCode>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The committed/signed-note boundary schema: proposal id, the committed FHIR
 * resource reference, the approver's identity (copied from the approve event
 * row — server truth), the committer, the signed-at timestamp, and the audit
 * row hash of the commit's allow decision. A record missing the approver
 * identity or the signature hash does not parse.
 */
export const signedNoteSchema = z.object({
  proposalId: z.uuid(),
  resource: z.object({
    resourceType: z.string().min(1),
    resourceId: z.uuid(),
    versionId: z.string().min(1)
  }),
  approverActorId: z.string().min(1),
  approvedAt: z.string().min(1),
  committerActorId: z.string().min(1),
  signedAt: z.string().min(1),
  commitAuditHash: z.string().regex(SHA256_HEX)
});
export type SignedNote = z.infer<typeof signedNoteSchema>;

/** The persisted identity + derived state a successful propose/approve returns. */
export interface ProposalRecord {
  readonly proposalId: string;
  readonly state: GovernanceState;
}
