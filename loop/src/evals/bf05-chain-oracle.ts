/**
 * An INDEPENDENT implementation of the bonfire audit-chain spec (documented in
 * drizzle/0007_audit_log.sql + docs), used by the bf05 Stage-2 evals. It shares
 * NO code with @bonfire/core (the harness-product firewall forbids importing
 * product code): canonicalization, the genesis constant, the advisory-lock
 * append and the verification walk are all re-derived here from the spec. That
 * independence is the point — a hash chain is only tamper-EVIDENT if a third
 * party can verify it from the stored rows alone; an eval that reused the
 * product's own hasher would prove nothing when the hasher itself drifts.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";

const SEQ_STEP = 1n;

export const EVAL_GENESIS = sha256(canonical({ domain: "bonfire.audit.v1.genesis" }));

/** RFC 8785 for the audit preimage: flat object of strings/null, sorted keys. */
export function canonical(fields: Record<string, string | null>): string {
  const sorted = Object.keys(fields).sort();
  const parts = sorted.map((key) => `${JSON.stringify(key)}:${JSON.stringify(fields[key])}`);
  return `{${parts.join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface OracleRow {
  readonly seq: string;
  readonly practice_id: string;
  readonly actor_id: string;
  readonly decision: string;
  readonly resource_type: string;
  readonly purpose_of_use: string;
  readonly matched_rule_id: string | null;
  readonly reason: string;
  readonly occurred_at: string;
  readonly prev_hash: string;
  readonly row_hash: string;
}

export function oracleRowHash(row: Omit<OracleRow, "row_hash">): string {
  return sha256(
    canonical({
      actor_id: row.actor_id,
      decision: row.decision,
      matched_rule_id: row.matched_rule_id,
      occurred_at: row.occurred_at,
      practice_id: row.practice_id,
      prev_hash: row.prev_hash,
      purpose_of_use: row.purpose_of_use,
      reason: row.reason,
      resource_type: row.resource_type,
      seq: row.seq
    })
  );
}

/** Append one spec-conformant row as the app role inside a tenant tx. */
export async function oracleAppend(
  app: postgres.Sql,
  practice: string,
  decision: "allow" | "deny",
  occurredAt: string
): Promise<void> {
  await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', ${practice}, true)`;
    await sql`select pg_advisory_xact_lock(hashtext('bonfire.audit.chain'),
      hashtext(coalesce(current_setting('app.current_practice_id', true), '')))`;
    const tip = await sql`
      select seq::text as seq, row_hash from audit_log order by audit_log.seq desc limit 1`;
    const tipRow = tip[0] as { seq: string; row_hash: string } | undefined;
    const seq = tipRow === undefined ? "1" : (BigInt(tipRow.seq) + SEQ_STEP).toString();
    const prev = tipRow === undefined ? EVAL_GENESIS : tipRow.row_hash;
    const base = {
      seq,
      practice_id: practice,
      actor_id: "eval-actor",
      decision,
      resource_type: "Observation",
      purpose_of_use: decision === "allow" ? "TREAT" : "HRESCH",
      matched_rule_id: decision === "allow" ? "v0-clinician-treat" : null,
      reason: `eval ${decision}`,
      occurred_at: occurredAt,
      prev_hash: prev
    };
    const rowHash = oracleRowHash(base);
    await sql`insert into audit_log
      (practice_id, seq, actor_id, decision, resource_type, purpose_of_use,
       matched_rule_id, reason, occurred_at, prev_hash, row_hash)
      values ((select safe_uuid(current_setting('app.current_practice_id', true))),
        ${base.seq}::bigint, ${base.actor_id}, ${base.decision}, ${base.resource_type},
        ${base.purpose_of_use}, ${base.matched_rule_id}, ${base.reason},
        ${base.occurred_at}::timestamptz, ${base.prev_hash}, ${rowHash})`;
  });
}

/** Read a tenant's chain (as the app role) in canonical text form. */
export async function oracleReadChain(app: postgres.Sql, practice: string): Promise<OracleRow[]> {
  return await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', ${practice}, true)`;
    const rows = await sql`
      select seq::text as seq, practice_id::text as practice_id, actor_id, decision,
        resource_type, purpose_of_use, matched_rule_id, reason,
        to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
        prev_hash, row_hash
      from audit_log order by audit_log.seq asc`;
    return rows as unknown as OracleRow[];
  });
}

export interface OracleVerdict {
  readonly ok: boolean;
  readonly rows: number;
  readonly brokenIndex?: number;
  readonly reason?: string;
}

/** Independent verification walk over stored rows (the spec, re-derived). */
export function oracleWalk(rows: readonly OracleRow[]): OracleVerdict {
  let expectedPrev = EVAL_GENESIS;
  for (const [index, row] of rows.entries()) {
    if (row.seq !== String(index + 1))
      return { ok: false, rows: rows.length, brokenIndex: index, reason: "seq_gap" };
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        rows: rows.length,
        brokenIndex: index,
        reason: index === 0 ? "genesis_mismatch" : "prev_hash_mismatch"
      };
    }
    const { row_hash: storedHash, ...rest } = row;
    if (oracleRowHash(rest) !== storedHash) {
      return { ok: false, rows: rows.length, brokenIndex: index, reason: "row_hash_mismatch" };
    }
    expectedPrev = storedHash;
  }
  return { ok: true, rows: rows.length };
}
