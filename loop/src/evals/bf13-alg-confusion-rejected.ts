/**
 * Execution eval bf13-alg-confusion-rejected (BF-13 acceptance #2; danger:
 * fail-open-authz).
 *
 * The `alg` a token is SIGNED with is attacker-controlled. Two forgeries — an
 * `alg:none` unsecured token and an HS256 token signed with the RSA PUBLIC key
 * as the HMAC secret (the classic RS256->HS256 confusion) — must both be
 * rejected as ALG_NOT_ALLOWED, because the accepted algorithm comes from the
 * product's POSITIVE allow-list, never from the token header. A legitimately
 * RS256-signed token verifying under the SAME config proves the rejection is the
 * allow-list at work, not a config that rejects everything.
 *
 * Inversion: widen the product allow-list to include HS256, or read the alg from
 * the header, and the confusion token verifies -> this flips red.
 */

import {
  authJob,
  mintKeys,
  runAuthenticate,
  signAlgNone,
  signHs256Confusion,
  signRs256
} from "./bf13-auth-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf13-alg-confusion-rejected";
const ALG_NOT_ALLOWED = "ALG_NOT_ALLOWED";

const keys = await mintKeys();

const none = runAuthenticate(EVAL_ID, authJob({ token: signAlgNone(), jwks: keys.jwks }));
if (none.verify.ok || none.verify.code !== ALG_NOT_ALLOWED) {
  fail(EVAL_ID, `alg:none not rejected as ALG_NOT_ALLOWED: ${JSON.stringify(none.verify)}`);
}

const hs = runAuthenticate(
  EVAL_ID,
  authJob({ token: await signHs256Confusion(keys), jwks: keys.jwks })
);
if (hs.verify.ok || hs.verify.code !== ALG_NOT_ALLOWED) {
  fail(EVAL_ID, `HS256 confusion not rejected as ALG_NOT_ALLOWED: ${JSON.stringify(hs.verify)}`);
}

const good = runAuthenticate(EVAL_ID, authJob({ token: await signRs256(keys), jwks: keys.jwks }));
if (!good.verify.ok) {
  fail(
    EVAL_ID,
    `non-vacuous check failed: a valid RS256 token did not verify: ${JSON.stringify(good.verify)}`
  );
}

pass(EVAL_ID, "alg:none and HS256-confusion both -> ALG_NOT_ALLOWED; valid RS256 verifies");
