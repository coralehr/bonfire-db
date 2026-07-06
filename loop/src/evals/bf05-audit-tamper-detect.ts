/**
 * Execution eval bf05-audit-tamper-detect (BF-05 danger check: audit-bypass;
 * closes ratchet BP-007).
 *
 * Proves the stored audit chain is THIRD-PARTY tamper-evident against the LIVE
 * stack, using an independent re-implementation of the documented chain spec
 * (bf05-chain-oracle — zero product code, per the harness-product firewall):
 * append 3 spec-conformant rows as the app role, verify the chain
 * independently, mutate a committed row as the OWNER (bypassing the
 * append-only REVOKE, which the app path cannot), and require the independent
 * walk to flag the exact broken index; restore and require clean. Stage-2
 * coverage no unit test provides: packages/core tests verify the chain with
 * the PRODUCT's own hasher — this eval proves the stored rows verify under a
 * hasher the product does not own, which is the property an audit chain
 * exists to provide.
 *
 * Inversion: weakening the chain construction (hash formula, genesis, seq
 * discipline) makes the oracle's clean-chain check fail; disabling tamper
 * detection is impossible to fake here because the detection IS the oracle.
 */
import postgres from "postgres";
import { oracleAppend, oracleReadChain, oracleWalk } from "./bf05-chain-oracle.js";
import { appUrl, fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf05-audit-tamper-detect";
const CLOCK = "2026-07-06T00:00:00.000Z";
const CHAIN_LENGTH = 3;

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practice = crypto.randomUUID();

try {
  await oracleAppend(app, practice, "allow", CLOCK);
  await oracleAppend(app, practice, "deny", CLOCK);
  await oracleAppend(app, practice, "allow", CLOCK);

  const clean = oracleWalk(await oracleReadChain(app, practice));
  if (!clean.ok || clean.rows !== CHAIN_LENGTH) {
    fail(EVAL_ID, `clean 3-row chain failed independent verification: ${JSON.stringify(clean)}`);
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
