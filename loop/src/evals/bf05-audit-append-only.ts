/**
 * Execution eval bf05-audit-append-only (BF-05 acceptance: the audit table is
 * append-only at the DB layer; BP-018 posture on the live stack).
 *
 * Raw app-role TCP client (no product code): an UPDATE and a DELETE against
 * audit_log must both be rejected with 42501 (insufficient_privilege), and
 * the has_table_privilege posture must show S/I only. Probes the LIVE grants
 * — a regression that re-grants U/D (or an initdb/migration drift) goes red
 * here even if every unit test was edited in the same commit.
 *
 * Inversion: GRANT UPDATE, DELETE ON audit_log TO bonfire_app flips this red.
 */
import postgres from "postgres";
import { oracleAppend } from "./bf05-chain-oracle.js";
import { appUrl, fail, pass } from "./eval-util.js";

const EVAL_ID = "bf05-audit-append-only";
const INSUFFICIENT_PRIVILEGE = "42501";

const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practice = crypto.randomUUID();

function pgCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return "no-code";
}

async function mutation(kind: "update" | "delete"): Promise<string> {
  try {
    await app.begin(async (sql) => {
      await sql`select set_config('app.current_practice_id', ${practice}, true)`;
      if (kind === "update") await sql`update audit_log set reason = 'tampered' where seq = 1`;
      else await sql`delete from audit_log where seq = 1`;
    });
    return "allowed";
  } catch (error) {
    return pgCode(error);
  }
}

try {
  // Non-vacuous: a committed row must exist for the mutation to target.
  await oracleAppend(app, practice, "deny", "2026-07-06T00:00:00.000Z");

  const updateCode = await mutation("update");
  const deleteCode = await mutation("delete");
  if (updateCode !== INSUFFICIENT_PRIVILEGE || deleteCode !== INSUFFICIENT_PRIVILEGE) {
    fail(EVAL_ID, `expected 42501/42501, got update=${updateCode} delete=${deleteCode}`);
  }

  const posture = await app`
    select has_table_privilege('bonfire_app', 'audit_log', 'UPDATE') as upd,
           has_table_privilege('bonfire_app', 'audit_log', 'DELETE') as del,
           has_table_privilege('bonfire_app', 'audit_log', 'INSERT') as ins,
           has_table_privilege('bonfire_app', 'audit_log', 'SELECT') as sel`;
  const row = posture[0] as { upd: boolean; del: boolean; ins: boolean; sel: boolean } | undefined;
  if (row === undefined || row.upd || row.del || !row.ins || !row.sel) {
    fail(EVAL_ID, `audit_log posture drifted: ${JSON.stringify(row)}`);
  }
  pass(EVAL_ID, "app UPDATE/DELETE both 42501; posture S/I only");
} finally {
  await app.end({ timeout: 5 });
}
