/**
 * scripts/governance-demo/govern.ts — an operator dev surface that drives the
 * BF-09 product governance path (proposeRecord / approveProposal /
 * commitProposal) headlessly, so the bf09 Stage-2 evals can assert against a
 * real @bonfire/core build across the harness<->product firewall.
 *
 * The evals live on the harness side and cannot import product code; they
 * shell out to THIS script, which composes the exact governance primitives the
 * SDK/API expose. The governance actor is passed IN (the store takes an
 * untrusted actor and parses it) — governance authority is decided by
 * decideGovernance, not by a membership lookup, so no token/JWKS is needed to
 * exercise the propose->approve->commit boundary; the eval seeds the actor's
 * role directly and the product default-denies everything that is not a
 * clinician approve/commit.
 *
 * argv[2] = a JSON job: { practiceId, steps: [{ op, actor, resource?,
 * proposalId? }] }. Each step runs in its OWN withTenant transaction (propose
 * commits before approve is a separate tx, mirroring the real request
 * lifecycle). stdout = one JSON line { results: [...] }, one entry per step in
 * order. Exit 0 unless the job itself is unreadable: a governance DENY or an
 * illegal transition is a STRUCTURED outcome, never a non-zero exit.
 */
import { z } from "zod";
import type { Result, TenantSql } from "../../packages/core/src/index.js";
import { approveProposal, connectTenantDb, proposeRecord } from "../../packages/core/src/index.js";
import { commitProjectedProposal } from "../../packages/sql-on-fhir/src/index.js";

const stepSchema = z.object({
  op: z.enum(["propose", "approve", "commit"]),
  actor: z.unknown(),
  resource: z.unknown().optional(),
  proposalId: z.string().optional()
});
const jobSchema = z.object({
  practiceId: z.string(),
  steps: z.array(stepSchema)
});
type Step = z.infer<typeof stepSchema>;

/** The flattened outcome of one step: the governance Result, or a tenant fault. */
type StepOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

function flatten<T>(
  outcome: Result<Result<T, { code: string; message?: string }>, { code: string; message?: string }>
): StepOutcome {
  // withTenant returns a DB/tenant fault as its own err; a governance decision
  // is the inner Result. Surface whichever applies without conflating them.
  if (!outcome.ok)
    return { ok: false, error: { code: outcome.error.code, message: outcome.error.message } };
  const inner = outcome.data;
  return inner.ok
    ? { ok: true, data: inner.data }
    : { ok: false, error: { code: inner.error.code, message: inner.error.message } };
}

function runStep(
  sql: TenantSql,
  step: Step
): Promise<Result<unknown, { code: string; message?: string }>> {
  switch (step.op) {
    case "propose":
      return proposeRecord(sql, { actor: step.actor, resource: step.resource });
    case "approve":
      return approveProposal(sql, { actor: step.actor, proposalId: step.proposalId ?? "" });
    case "commit":
      return commitProjectedProposal(sql, {
        actor: step.actor,
        proposalId: step.proposalId ?? ""
      });
  }
}

async function main(): Promise<number> {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("usage: govern.ts '<json job>'\n");
    return 1;
  }
  const parsed = jobSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    process.stderr.write(`govern.ts: invalid job — ${parsed.error.message}\n`);
    return 1;
  }
  const job = parsed.data;
  const db = connectTenantDb();
  const results: StepOutcome[] = [];
  try {
    for (const step of job.steps) {
      const outcome = await db.withTenant(job.practiceId, (sql) => runStep(sql, step));
      results.push(flatten(outcome));
    }
  } finally {
    await db.end();
  }
  process.stdout.write(`${JSON.stringify({ results })}\n`);
  return 0;
}

process.exitCode = await main();
