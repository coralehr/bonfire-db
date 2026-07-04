/**
 * spidx row DML shared verbatim by the offline rebuild and the in-transaction
 * upsert (one write shape, two callers). practice_id arrives as a fragment:
 * a literal uuid on the owner rebuild path, the GUC-derived subselect inside
 * a tenant transaction.
 */
import type { Fragment } from "postgres";
import type { SpidxRow } from "../spidx.js";
import type { SqlHandle } from "./ddl.js";

export async function insertSpidxRows(
  sql: SqlHandle,
  practice: Fragment,
  resourceId: string,
  rows: readonly SpidxRow[]
): Promise<void> {
  for (const row of rows) {
    await sql`insert into spidx (
      practice_id, resource_id, resource_type, param_name, param_type,
      token_system, token_code, ref_value
    ) values (
      ${practice}, ${resourceId}, ${row.resourceType}, ${row.paramName}, ${row.paramType},
      ${row.tokenSystem}, ${row.tokenCode}, ${row.refValue}
    )`;
  }
}

/** The GUC-derived tenant fragment used on every in-transaction write. */
export function practiceFromGuc(sql: SqlHandle): Fragment {
  return sql`(select safe_uuid(current_setting('app.current_practice_id', true)))`;
}
