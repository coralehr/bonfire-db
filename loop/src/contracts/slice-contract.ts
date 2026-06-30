/**
 * The slice contract: the typed, Zod-validated unit of work the loop gates.
 *
 * Each Bonfire product slice (BF-01..BF-13, mvp-demo-plan.md) is described by one
 * contract. The schema is the boundary: every field is parsed, not trusted, so a
 * malformed registry entry can never reach the gate pipeline. Shape source of
 * truth: loop-harness-plan.md section 3.3.
 *
 * Note on default-deny: the secrets/real-data/gates/harness floor is NOT enforced
 * per-slice here — it lives in `GLOBAL_FORBIDDEN_PATHS` in allowed-paths.ts and is
 * applied by the checker to every slice. A slice's `forbiddenPaths` only adds
 * slice-specific extras on top of that floor.
 */
import { z } from "zod";

/** The kind of work a slice represents; drives gate profile and agent selection. */
export const sliceProfileSchema = z.enum([
  "foundation",
  "data",
  "fhir",
  "retrieval",
  "security",
  "contract",
  "mcp",
  "agent-safety",
  "ui",
  "ui-security",
  "benchmark",
  "docs-release"
]);
export type SliceProfile = z.infer<typeof sliceProfileSchema>;

/**
 * Product failure modes a slice is responsible for guarding (mvp-demo-plan.md
 * "Dangerous failure modes"). A slice declares only the checks it owns.
 */
export const dangerCheckSchema = z.enum([
  "scope-after-retrieve",
  "cross-tenant-leak",
  "lossy-fhir",
  "fake-conformance",
  "fail-open-authz",
  "audit-bypass",
  "propose-only-broken"
]);
export type DangerCheck = z.infer<typeof dangerCheckSchema>;

/** Harness agents a slice may require. `maker` and `verifier` are always required. */
export const requiredAgentSchema = z.enum(["planner", "maker", "verifier", "security-auditor"]);
export type RequiredAgent = z.infer<typeof requiredAgentSchema>;

/** Slice id pattern: `BF-` followed by exactly two digits (BF-01 .. BF-13). */
export const SLICE_ID_PATTERN = /^BF-\d{2}$/;

const sliceIdSchema = z.string().regex(SLICE_ID_PATTERN, "must match /^BF-\\d{2}$/");

const nonEmptyString = z.string().min(1);

const capsSchema = z.strictObject({
  maxAttempts: z.number().int().min(1),
  maxTurns: z.number().int().min(1),
  maxBudgetUSD: z.number().positive()
});

const requiredAgentsSchema = z
  .array(requiredAgentSchema)
  .refine((agents) => agents.includes("maker") && agents.includes("verifier"), {
    message: "requiredAgents must include both 'maker' and 'verifier'"
  });

export const sliceContractSchema = z.strictObject({
  id: sliceIdSchema,
  title: nonEmptyString,
  profile: sliceProfileSchema,
  goal: nonEmptyString,
  why: nonEmptyString,
  dependsOn: z.array(sliceIdSchema),
  allowedPaths: z.array(nonEmptyString).min(1),
  // Slice-specific extras only; the security floor is global (allowed-paths.ts).
  forbiddenPaths: z.array(nonEmptyString),
  acceptance: z.array(nonEmptyString).min(1),
  verify: z.array(nonEmptyString).min(1),
  evals: z.array(nonEmptyString),
  dangerChecks: z.array(dangerCheckSchema),
  caps: capsSchema,
  requiredAgents: requiredAgentsSchema,
  greptileRequired: z.literal(true)
});

export type SliceContract = z.infer<typeof sliceContractSchema>;
