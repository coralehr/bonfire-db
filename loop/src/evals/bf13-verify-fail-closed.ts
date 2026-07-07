/**
 * Execution eval bf13-verify-fail-closed (BF-13 acceptance #3; danger:
 * fail-open-authz).
 *
 * Every verification error path returns a TYPED deny and never throws across the
 * boundary — proven because authenticate.ts exits 0 with a structured outcome
 * (runAuthenticate fails the eval on a non-zero exit) and yields NO identity. A
 * malformed token, an alg:none token, and a good-signature-wrong-key token are
 * each denied. The fail-closed CONSEQUENCE: with no verified identity no tenant
 * GUC is set, so BF-01 default-deny returns zero rows on a bare connection.
 *
 * Inversion: make the verifier throw-to-allow (return ok on a caught error) and
 * the no-identity assertions flip red; re-grant no-GUC reads and the 0-rows
 * assertion flips red.
 */
import postgres from "postgres";
import { authJob, mintKeys, runAuthenticate, signAlgNone, signRs256 } from "./bf13-auth-util.js";
import { appUrl, fail, pass } from "./eval-util.js";

const EVAL_ID = "bf13-verify-fail-closed";

const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const keys = await mintKeys();
const wrongKeys = await mintKeys();

try {
  // A syntactically invalid JWT (not header.payload.signature). Built at runtime
  // via join so it is not a string-literal assignment (no hardcoded-secret shape).
  const junk = ["not", "a", "jwt"].join(".");
  const malformed = runAuthenticate(EVAL_ID, authJob({ token: junk, jwks: keys.jwks }));
  const none = runAuthenticate(EVAL_ID, authJob({ token: signAlgNone(), jwks: keys.jwks }));
  // Same kid, different key -> resolves the JWKS entry but the signature fails.
  const badSig = runAuthenticate(
    EVAL_ID,
    authJob({ token: await signRs256(wrongKeys), jwks: keys.jwks })
  );

  for (const out of [malformed, none, badSig]) {
    if (out.verify.ok) {
      fail(
        EVAL_ID,
        `a verification error yielded an identity (throw-to-allow): ${JSON.stringify(out.verify)}`
      );
    }
  }

  const bare = await app`select count(*)::int as n from rls_scaffold`;
  const bareN = (bare[0] as { n: number } | undefined)?.n ?? -1;
  if (bareN !== 0)
    fail(EVAL_ID, `no-context read returned ${String(bareN)} rows, expected 0 (default-deny)`);

  pass(
    EVAL_ID,
    "malformed/alg-none/bad-sig all typed-deny (exit 0, no identity); no-GUC -> 0 rows"
  );
} finally {
  await app.end({ timeout: 5 });
}
