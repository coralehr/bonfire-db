/**
 * Execution eval bf13-iss-aud-exp-enforced (BF-13 acceptance #3).
 *
 * A signature-valid RS256 token still fails closed when a registered claim is
 * wrong: a wrong issuer or audience -> CLAIM_INVALID, an expired token ->
 * TOKEN_EXPIRED, and — the requiredClaims:["exp"] hardening — a token minted
 * with NO exp -> CLAIM_INVALID (a trusted-IdP token without an expiry must not
 * grant permanent access). Every case returns a typed error and yields no
 * identity, so no tenant context is ever set.
 *
 * Inversion: drop the issuer/audience assertion or requiredClaims:["exp"] from
 * the product verifier and the matching case verifies -> this flips red.
 */

import { authJob, expiredExp, mintKeys, runAuthenticate, signRs256 } from "./bf13-auth-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf13-iss-aud-exp-enforced";
const CLAIM_INVALID = "CLAIM_INVALID";
const TOKEN_EXPIRED = "TOKEN_EXPIRED";

const keys = await mintKeys();

const cases = [
  {
    name: "wrong-iss",
    token: await signRs256(keys, { iss: "https://evil.bf13-eval.test/" }),
    code: CLAIM_INVALID
  },
  { name: "wrong-aud", token: await signRs256(keys, { aud: "not-bonfire" }), code: CLAIM_INVALID },
  {
    name: "expired",
    token: await signRs256(keys, { expiresIn: expiredExp() }),
    code: TOKEN_EXPIRED
  },
  { name: "no-exp", token: await signRs256(keys, { omitExp: true }), code: CLAIM_INVALID }
];

for (const c of cases) {
  const out = runAuthenticate(EVAL_ID, authJob({ token: c.token, jwks: keys.jwks }));
  if (out.verify.ok || out.verify.code !== c.code) {
    fail(EVAL_ID, `${c.name}: expected ${c.code}, got ${JSON.stringify(out.verify)}`);
  }
}

pass(
  EVAL_ID,
  "wrong iss/aud -> CLAIM_INVALID; expired -> TOKEN_EXPIRED; missing exp -> CLAIM_INVALID"
);
