/**
 * Execution eval bf13-auth-decision-audited (BF-13 acceptance #7; danger:
 * audit-bypass).
 *
 * Every authentication decision writes exactly one append-only hash-chained
 * audit row carrying the serialized issuer/subject tuple, the resolved practice_id (or
 * none), and the decision:
 *   success -> exactly one `allow` row on the RESOLVED practice's chain
 *   failure -> exactly one `deny` row on the reserved SYSTEM practice's chain
 * The rows are located by the product-returned row_hash (unique per row), read
 * as the OWNER (RLS-exempt) so the SYSTEM chain is visible; then RLS is proven
 * to keep the SYSTEM deny row INVISIBLE to a real tenant.
 *
 * Inversion: drop the auth-decision audit call and the row_hash lookups return
 * nothing -> red; give SYSTEM rows a tenant-visible policy and the isolation
 * check flips red.
 */

import type { Sql } from "postgres";
import postgres from "postgres";
import {
  authJob,
  issuer,
  mintKeys,
  runAuthenticate,
  signAlgNone,
  signRs256
} from "./bf13-auth-util.js";
import { appUrl, fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf13-auth-decision-audited";
const SYSTEM_PRACTICE = "00000000-0000-4000-8000-000000000000";
const AUTH_RESOURCE_TYPE = "Authentication";

interface AuditRow {
  readonly practice_id: string;
  readonly actor_id: string;
  readonly decision: string;
  readonly resource_type: string;
}

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const keys = await mintKeys();
const sub = crypto.randomUUID();
const practice = crypto.randomUUID();

async function rowsByHash(client: Sql, hash: string): Promise<readonly AuditRow[]> {
  const rows =
    await client`select practice_id::text as practice_id, actor_id, decision, resource_type
    from audit_log where row_hash = ${hash}`;
  return rows as unknown as AuditRow[];
}

try {
  await owner`insert into membership (iss, sub, practice_id, role)
    values (${issuer}, ${sub}, ${practice}::uuid, 'clinician')`;

  // SUCCESS -> exactly one allow row on the resolved practice's chain.
  const success = runAuthenticate(
    EVAL_ID,
    authJob({ token: await signRs256(keys, { sub }), jwks: keys.jwks, resolve: true, audit: true })
  );
  const sAudit = success.audit;
  if (sAudit === null || "error" in sAudit)
    fail(EVAL_ID, `success not audited: ${JSON.stringify(sAudit)}`);
  const sRows = await rowsByHash(owner, sAudit.auditRowHash);
  const sRow = sRows[0];
  if (sRows.length !== 1 || sRow === undefined)
    fail(EVAL_ID, `success wrote ${String(sRows.length)} rows, expected 1`);
  if (
    sRow.decision !== "allow" ||
    sRow.practice_id !== practice ||
    sRow.actor_id !== JSON.stringify([issuer, sub]) ||
    sRow.resource_type !== AUTH_RESOURCE_TYPE
  ) {
    fail(EVAL_ID, `success row wrong: ${JSON.stringify(sRow)}`);
  }

  // FAILURE (alg:none) -> exactly one deny row on the SYSTEM chain, actor unverified.
  const failure = runAuthenticate(
    EVAL_ID,
    authJob({ token: signAlgNone({ sub }), jwks: keys.jwks, resolve: true, audit: true })
  );
  const fAudit = failure.audit;
  if (fAudit === null || "error" in fAudit)
    fail(EVAL_ID, `failure not audited: ${JSON.stringify(fAudit)}`);
  const fRows = await rowsByHash(owner, fAudit.auditRowHash);
  const fRow = fRows[0];
  if (fRows.length !== 1 || fRow === undefined)
    fail(EVAL_ID, `failure wrote ${String(fRows.length)} rows, expected 1`);
  if (
    fRow.decision !== "deny" ||
    fRow.practice_id !== SYSTEM_PRACTICE ||
    fRow.actor_id !== "unverified"
  ) {
    fail(EVAL_ID, `failure row wrong: ${JSON.stringify(fRow)}`);
  }

  // SYSTEM isolation: a real tenant cannot read the SYSTEM deny row (RLS holds).
  const leaked = await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', ${practice}, true)`;
    const rows =
      await sql`select count(*)::int as n from audit_log where row_hash = ${fAudit.auditRowHash}`;
    return (rows[0] as { n: number } | undefined)?.n ?? -1;
  });
  if (leaked !== 0) fail(EVAL_ID, `tenant ${practice} could read the SYSTEM audit row (leak)`);

  pass(
    EVAL_ID,
    "success=1 allow (resolved practice, issuer/subject tuple); failure=1 deny (SYSTEM, unverified); SYSTEM invisible to tenant"
  );
} finally {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}
