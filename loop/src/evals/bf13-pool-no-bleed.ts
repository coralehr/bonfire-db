/**
 * Execution eval bf13-pool-no-bleed (BF-13 acceptance #5; closes BP-005 —
 * cross-tenant-leak / pooled-connection context bleed).
 *
 * Three probes on a max:1 pool (one physical connection, so a checkout literally
 * reuses the prior one):
 *   1. POSITIVE CONTROL — a session-level SET (transaction-local=false) DOES
 *      persist onto the next checkout. This is the BP-005 bleed; proving the
 *      probe can SEE it makes the no-bleed result non-vacuous.
 *   2. THE PRODUCT PATH — connectTenantDb().withTenant (transaction-local
 *      set_config(...,true)) for practice A then B on that same connection; B
 *      must see ONLY its own rows (never A's), so context never bleeds.
 *   3. A bare connection with no identity (no GUC) returns zero rows.
 *
 * The transaction-local `set_config(...,true)` pattern is guaranteed
 * STRUCTURALLY by the semgrep ban on session-level SET for app.* GUCs
 * (bonfire-session-set-app-guc) — that is BP-005's load-bearing guard. This eval
 * is the live behavioral proof: the DB-level bleed IS real (probe 1) and
 * withTenant delivers per-checkout tenant isolation (probe 2). Inversion: disable
 * RLS (or drop the policy) on rls_scaffold and probe 2's A-count balloons past
 * N_A / the bare read returns rows -> red (proven live in the close-out).
 */
import postgres from "postgres";
import { appUrl, fail, pass, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf13-pool-no-bleed";
const N_A = 2;
const N_B = 1;

const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practiceA = crypto.randomUUID();
const practiceB = crypto.randomUUID();

try {
  // (1) Positive control: session SET bleeds across the checkout.
  await app`select set_config('app.current_practice_id', ${practiceA}, false)`;
  const bledRow = await app`select current_setting('app.current_practice_id', true) as v`;
  const bled = (bledRow[0] as { v: string | null } | undefined)?.v ?? null;
  if (bled !== practiceA) {
    fail(EVAL_ID, `positive control failed: a session SET did not persist (got ${String(bled)})`);
  }
  await app`select set_config('app.current_practice_id', '', false)`; // clear the bleed

  // (2) Product path: withTenant over max:1 — B must see only its own rows.
  const probe = runArtifact(EVAL_ID, [
    "bun",
    "scripts/auth-demo/pooled-probe.ts",
    practiceA,
    practiceB,
    String(N_A),
    String(N_B)
  ]);
  if (probe.status !== 0) fail(EVAL_ID, `pooled-probe failed:\n${probe.output}`);
  const last = probe.output.trim().split("\n").at(-1) ?? "";
  const counts = JSON.parse(last) as { aCount: number; bCount: number };
  if (counts.aCount !== N_A)
    fail(EVAL_ID, `A saw ${String(counts.aCount)} rows, expected ${String(N_A)}`);
  if (counts.bCount !== N_B) {
    fail(
      EVAL_ID,
      `BLEED: B saw ${String(counts.bCount)} rows, expected ${String(N_B)} (A+B=${String(N_A + N_B)})`
    );
  }

  // (3) A fresh connection with no verified identity yields zero rows.
  const bare = await app`select count(*)::int as n from rls_scaffold`;
  const bareN = (bare[0] as { n: number } | undefined)?.n ?? -1;
  if (bareN !== 0) fail(EVAL_ID, `no-identity connection saw ${String(bareN)} rows, expected 0`);

  pass(EVAL_ID, "session-SET bleeds (control); withTenant no-bleed (A=2, B=1); bare conn = 0");
} finally {
  await app.end({ timeout: 5 });
}
