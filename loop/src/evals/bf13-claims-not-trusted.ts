/**
 * Execution eval bf13-claims-not-trusted (BF-13 acceptance #4; danger:
 * privilege-escalation / fail-open-authz).
 *
 * A verified token whose body ASSERTS a `practice_id`/`role` different from its
 * `(iss, sub)` membership row must be scoped by the MEMBERSHIP row, never the
 * claim. The membership row is owner-seeded (bonfire_app cannot INSERT it — the
 * trust anchor); the token carries forged practice_id/role claims that resolve
 * to the REAL practice regardless. A verified `sub` with NO membership row is
 * denied (no tenant context).
 *
 * Inversion: source practice_id/role from a token claim instead of the
 * membership lookup and the resolved practice becomes the forged one -> red.
 */
import postgres from "postgres";
import { authJob, issuer, mintKeys, runAuthenticate, signRs256 } from "./bf13-auth-util.js";
import { fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf13-claims-not-trusted";

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const keys = await mintKeys();
const sub = crypto.randomUUID();
const practiceReal = crypto.randomUUID();
const practiceEvil = crypto.randomUUID();

try {
  await owner`insert into membership (iss, sub, practice_id, role)
    values (${issuer}, ${sub}, ${practiceReal}::uuid, 'clinician')`;

  const token = await signRs256(keys, {
    sub,
    claims: { practice_id: practiceEvil, practiceId: practiceEvil, role: "admin" }
  });
  const out = runAuthenticate(EVAL_ID, authJob({ token, jwks: keys.jwks, resolve: true }));
  if (!out.verify.ok) fail(EVAL_ID, `valid token failed to verify: ${JSON.stringify(out.verify)}`);

  const m = out.membership;
  if (m === null || m === "none") fail(EVAL_ID, `membership not resolved: ${JSON.stringify(m)}`);
  if ("error" in m) fail(EVAL_ID, `membership lookup errored: ${JSON.stringify(m)}`);
  if (m.practiceId !== practiceReal) {
    fail(
      EVAL_ID,
      `practice from the CLAIM not membership: got ${m.practiceId}, want ${practiceReal}`
    );
  }
  if (m.role !== "clinician") fail(EVAL_ID, `role from the CLAIM not membership: got ${m.role}`);

  const orphan = await signRs256(keys, { sub: crypto.randomUUID() });
  const denied = runAuthenticate(
    EVAL_ID,
    authJob({ token: orphan, jwks: keys.jwks, resolve: true })
  );
  if (denied.membership !== "none") {
    fail(EVAL_ID, `an unprovisioned sub was not denied: ${JSON.stringify(denied.membership)}`);
  }

  pass(
    EVAL_ID,
    "practice_id/role come from the membership row, not token claims; no-membership denied"
  );
} finally {
  await owner.end({ timeout: 5 });
}
