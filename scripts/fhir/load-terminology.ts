/**
 * fhir:load-terminology — load the license-clean bundled packs into the GLOBAL
 * terminology tables. Connects as the migration owner (bonfire_app is SELECT-only
 * on this reference data), reads fixtures/terminology/packs.json + each CSV,
 * stamps system+version per pack, and records sha256(csv) provenance. Idempotent:
 * re-running upserts. Parameterized `sql` templates only — never interpolated SQL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { z } from "zod";
import { devDatabaseUrl } from "../../packages/core/src/index.js";

type Sql = ReturnType<typeof postgres>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TERMINOLOGY_DIR = join(REPO_ROOT, "fixtures", "terminology");
const POOL_MAX = 1;
const END_TIMEOUT_SECONDS = 5;

const packSchema = z.object({
  name: z.string().min(1),
  system: z.string().min(1),
  version: z.string().min(1),
  file: z.string().min(1),
  source_url: z.string().min(1),
  license: z.string().min(1)
});
const packsFileSchema = z.object({ packs: z.array(packSchema) });
type Pack = z.infer<typeof packSchema>;

function parseCsvRow(line: string): { code: string; display: string } | undefined {
  const comma = line.indexOf(",");
  if (comma < 0) return undefined;
  const code = line.slice(0, comma).trim();
  let display = line.slice(comma + 1).trim();
  if (display.startsWith('"') && display.endsWith('"')) {
    display = display.slice(1, -1).replace(/""/g, '"');
  }
  return code.length === 0 ? undefined : { code, display };
}

function readConcepts(pack: Pack): { csv: string; rows: { code: string; display: string }[] } {
  const csv = readFileSync(join(TERMINOLOGY_DIR, pack.file), "utf8");
  const lines = csv.split(/\r?\n/).slice(1);
  const rows = lines
    .map(parseCsvRow)
    .filter((row): row is { code: string; display: string } => row !== undefined);
  return { csv, rows };
}

async function loadPack(sql: Sql, pack: Pack): Promise<number> {
  const { csv, rows } = readConcepts(pack);
  const sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  await sql`
    insert into terminology_pack (name, version, sha256, source_url, license)
    values (${pack.name}, ${pack.version}, ${sha256}, ${pack.source_url}, ${pack.license})
    on conflict (name) do update set version = excluded.version, sha256 = excluded.sha256,
      source_url = excluded.source_url, license = excluded.license`;
  for (const row of rows) {
    await sql`
      insert into terminology_concept (system, code, display, version)
      values (${pack.system}, ${row.code}, ${row.display}, ${pack.version})
      on conflict (system, code) do update set display = excluded.display, version = excluded.version`;
  }
  return rows.length;
}

async function main(): Promise<number> {
  const rawManifest: unknown = JSON.parse(
    readFileSync(join(TERMINOLOGY_DIR, "packs.json"), "utf8")
  );
  const manifest = packsFileSchema.parse(rawManifest);
  const url = process.env.MIGRATE_DATABASE_URL ?? devDatabaseUrl("migrate");
  const sql = postgres(url, { max: POOL_MAX });
  try {
    for (const pack of manifest.packs) {
      const count = await loadPack(sql, pack);
      process.stdout.write(
        `fhir:load-terminology: ${pack.name}@${pack.version} — ${String(count)} concepts\n`
      );
    }
    return 0;
  } finally {
    await sql.end({ timeout: END_TIMEOUT_SECONDS });
  }
}

process.exitCode = await main();
