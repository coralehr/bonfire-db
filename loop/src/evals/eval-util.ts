/**
 * Shared scaffolding for Stage-2 execution evals: repo-root resolution, the
 * fail-loud exit, subprocess spawning of BUILT artifacts, and dev-stack
 * connection strings. Evals exercise the product strictly as an external
 * subprocess / TCP client (the harness-product firewall bans loop -> product
 * imports); the synthetic dev credentials below mirror .env.example and are
 * overridable via the same env vars the product honors.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function fail(evalId: string, reason: string): never {
  process.stderr.write(`eval ${evalId} FAILED: ${reason}\n`);
  process.exit(1);
}

export function pass(evalId: string, summary: string): void {
  process.stdout.write(`eval ${evalId} PASS: ${summary}\n`);
}

/**
 * Parse the LAST non-empty line of a product subprocess's output as JSON. A
 * leading DB notice never corrupts the parse, and an empty or non-JSON tail is a
 * loud eval failure. Shared by the product-driving eval utils (auth, search).
 */
export function lastJsonLine(evalId: string, output: string): unknown {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) fail(evalId, "subprocess produced no output");
  try {
    return JSON.parse(last);
  } catch (_cause) {
    return fail(evalId, `subprocess output is not JSON:\n${output}`);
  }
}

export interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/** Ceiling per artifact run: a wedged DB must fail the eval, not hang CI. */
const RUN_TIMEOUT_MS = 600_000;

/** Run a repo script as a subprocess; spawn failure is a loud eval failure. */
export function runArtifact(
  evalId: string,
  argv: readonly string[],
  env?: Readonly<Record<string, string>>
): RunResult {
  const [command, ...args] = argv;
  if (command === undefined) fail(evalId, "empty argv");
  const run = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: env === undefined ? process.env : { ...process.env, ...env }
  });
  if (run.error !== undefined)
    fail(evalId, `could not run ${argv.join(" ")}: ${run.error.message}`);
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function hostPort(): string {
  return process.env.DB_HOST_PORT ?? "5432";
}

/** Migration-owner URL (RLS-exempt; catalog + ground-truth reads). */
export function ownerUrl(): string {
  return (
    process.env.MIGRATE_DATABASE_URL ??
    `postgres://postgres:bonfire-dev-only-superuser-pw@127.0.0.1:${hostPort()}/bonfire`
  );
}

/** Runtime bonfire_app URL (RLS-subject; the role under eval). */
export function appUrl(): string {
  return (
    process.env.DATABASE_URL ??
    `postgres://bonfire_app:bonfire-dev-only-app-pw@127.0.0.1:${hostPort()}/bonfire`
  );
}
