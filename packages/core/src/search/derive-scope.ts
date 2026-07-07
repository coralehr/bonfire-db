/**
 * Scope-before-retrieve: probe the BF-05 `decide()` authority ONCE per searchable
 * clinical type BEFORE any row is fetched, partitioning the 8 types into an
 * allow-list (searched) and an excluded-list (withheld, with the deny reason).
 * `decide()` is total and default-deny — an unknown role, a non-TREAT purpose, a
 * cross-practice subject, or an internal error all resolve to a deny receipt, so
 * a type reaches `allowed` ONLY on an explicit allow (fail-closed by construction).
 */
import { decide } from "../abac/decide.js";
import type { PurposeOfUse, Role } from "../abac/types.js";
import type { ExcludedType } from "./schemas.js";

/**
 * The search domain's own clinical type set (NOT copied from abac's private
 * CLINICAL_RESOURCE_TYPES — decide() stays the sole authority on allow).
 */
export const SEARCHABLE_TYPES = [
  "Patient",
  "Encounter",
  "Condition",
  "Observation",
  "MedicationRequest",
  "AllergyIntolerance",
  "Procedure",
  "DocumentReference"
] as const;

export interface ScopeSubject {
  readonly id: string;
  readonly role: Role;
  readonly practiceId: string;
}

export interface DerivedScope {
  readonly allowed: readonly string[];
  readonly excluded: readonly ExcludedType[];
}

/** True when a resource type is in the search domain (indexer + read gate share it). */
export function isSearchableType(type: string): boolean {
  return SEARCHABLE_TYPES.some((t) => t === type);
}

export function deriveScope(
  subject: ScopeSubject,
  purposeOfUse: PurposeOfUse,
  requestPracticeId: string,
  now: () => string
): DerivedScope {
  const allowed: string[] = [];
  const excluded: ExcludedType[] = [];
  for (const resourceType of SEARCHABLE_TYPES) {
    const receipt = decide(
      {
        subject,
        resource: { resourceType, practiceId: requestPracticeId },
        purposeOfUse,
        requestPracticeId
      },
      now
    );
    if (receipt.decision === "allow") allowed.push(resourceType);
    else
      excluded.push({ resourceType, reason: receipt.reason, matchedRuleId: receipt.matchedRuleId });
  }
  return { allowed, excluded };
}
