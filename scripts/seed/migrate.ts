import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const migrationsDir = join(process.cwd(), "drizzle");
const readinessAttempts = 30;

function migrationHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function runPsql(args: string[], input?: string): string {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "bonfire", "-d", "bonfire", ...args],
    { encoding: "utf8", input }
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "psql failed").trim());
  }

  return result.stdout;
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
    try {
      runPsql(["-c", "SELECT 1"]);
      return;
    } catch (error) {
      if (attempt === readinessAttempts) throw error;
      await delay(1000);
    }
  }
}

function appliedMigrationMap(): Map<string, string> {
  const output = runPsql(["-At", "-F", "|", "-c", "SELECT version, checksum FROM schema_migrations"]);
  const entries = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [version, checksum] = line.split("|");
      if (!version || !checksum) throw new Error(`invalid schema_migrations row: ${line}`);
      return [version, checksum] as const;
    });

  return new Map(entries);
}

async function run(): Promise<void> {
  try {
    await waitForDatabase();

    runPsql([
      "-c",
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `
    ]);

    const applied = appliedMigrationMap();

    for (const file of await migrationFiles()) {
      const contents = await readFile(join(migrationsDir, file), "utf8");
      const checksum = migrationHash(contents);
      const appliedChecksum = applied.get(file);

      if (appliedChecksum) {
        if (appliedChecksum !== checksum) {
          throw new Error(`migration checksum changed for ${file}`);
        }
        console.log(`migrate: skip ${file}`);
        continue;
      }

      runPsql(
        ["-f", "-"],
        `
          BEGIN;
          ${contents}
          INSERT INTO schema_migrations (version, checksum)
          VALUES (${sqlLiteral(file)}, ${sqlLiteral(checksum)});
          COMMIT;
        `
      );

      console.log(`migrate: applied ${file}`);
    }

    console.log("migrate: PASS");
  } catch (error) {
    console.error(`migrate: FAIL ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

await run();
