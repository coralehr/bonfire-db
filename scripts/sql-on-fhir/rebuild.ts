/**
 * projections:rebuild — drop + rebuild every vd_* projection and the spidx
 * index from canonical fhir_resources. Connects as the MIGRATION OWNER (DDL
 * plus full-corpus scan; the runtime bonfire_app role can never DDL): this is
 * an operator-run offline task, mirroring scripts/fhir/load-terminology.ts.
 */
import postgres from "postgres";
import { devDatabaseUrl } from "../../packages/core/src/index.js";
import { loadScribeViews, rebuildProjections } from "../../packages/sql-on-fhir/src/index.js";

const POOL_MAX = 1;
const END_TIMEOUT_SECONDS = 5;

async function main(): Promise<number> {
  const views = loadScribeViews();
  if (!views.ok) {
    process.stderr.write(
      `scribe views failed to load: [${views.error.code}] ${views.error.message}\n`
    );
    return 1;
  }
  const url = process.env.MIGRATE_DATABASE_URL ?? devDatabaseUrl("migrate");
  // Notices are noise here: `drop table if exists` chatters on first runs.
  const sql = postgres(url, { max: POOL_MAX, onnotice: () => undefined });
  try {
    const summary = await rebuildProjections(sql, views.data);
    if (!summary.ok) {
      process.stderr.write(`rebuild failed: [${summary.error.code}] ${summary.error.message}\n`);
      return 1;
    }
    const tables = Object.entries(summary.data.tableRows)
      .map(([table, count]) => `${table}=${String(count)}`)
      .join(" ");
    process.stdout.write(
      `projections rebuilt from ${String(summary.data.resources)} resources: ${tables} ` +
        `spidx=${String(summary.data.spidxRows)}\n`
    );
    return 0;
  } finally {
    await sql.end({ timeout: END_TIMEOUT_SECONDS });
  }
}

process.exitCode = await main();
