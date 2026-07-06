/**
 * Execution eval bf05-audit-tamper-detect (BF-05 danger check: audit-bypass;
 * closes ratchet BP-007).
 *
 * Proves the stored audit chain is THIRD-PARTY tamper-evident against the LIVE
 * stack. The rows are written by the PRODUCT write path (@bonfire/core
 * authorizeAndAudit, invoked as a subprocess so the harness-product firewall
 * is honoured), then VERIFIED by an independent re-implementation of the chain
 * spec (bf05-chain-oracle — zero product code). That split is the whole point:
 * the independent walker over product-written row_hashes is a genuine
 * cross-implementation check, so a future drift between the product hasher and
 * the documented spec goes red here even if every product unit test (which
 * uses the product's own hasher) stays green. Then a committed row is mutated
 * as the OWNER (bypassing the append-only REVOKE the app path cannot), and the
 * independent walk must flag the exact broken index; restore must re-verify.
 *
 * Inversion: drift the product preimage → the oracle's clean-chain walk over
 * product rows fails; stub the detection → impossible to fake, the detection
 * IS the oracle.
 */
import postgres from "postgres";
import { oracleReadChain, oracleWalk } from "./bf05-chain-oracle.js";
import { appUrl, fail, ownerUrl, pass, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf05-audit-tamper-detect";
const CHAIN_LENGTH = 3;

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practice = crypto.randomUUID();

try {
  // Product path writes the chain (real authorizeAndAudit + product hasher).
  const append = runArtifact(EVAL_ID, [
    "bun",
    "scripts/audit-demo/append.ts",
    practice,
    String(CHAIN_LENGTH)
  ]);
  if (append.status !== 0) {
    fail(EVAL_ID, `product append failed:\n${append.output}`);
  }

  const clean = oracleWalk(await oracleReadChain(app, practice));
  if (!clean.ok || clean.rows !== CHAIN_LENGTH) {
    fail(EVAL_ID, `independent walk over PRODUCT-written rows failed: ${JSON.stringify(clean)}`);
  }

  await owner`update audit_log set decision = 'allow'
    where practice_id = ${practice}::uuid and seq = 2`;
  const tampered = oracleWalk(await oracleReadChain(app, practice));
  if (tampered.ok) {
    fail(EVAL_ID, "owner-mutated row 2 was NOT detected by the independent walk");
  }
  if (tampered.brokenIndex !== 1 || tampered.reason !== "row_hash_mismatch") {
    fail(EVAL_ID, `tamper flagged at wrong link: ${JSON.stringify(tampered)}`);
  }

  await owner`update audit_log set decision = 'deny'
    where practice_id = ${practice}::uuid and seq = 2`;
  const restored = oracleWalk(await oracleReadChain(app, practice));
  if (!restored.ok) fail(EVAL_ID, `restored chain still broken: ${JSON.stringify(restored)}`);

  pass(
    EVAL_ID,
    "independent oracle: clean chain verifies; owner tamper flagged at exact index; restore clean"
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
