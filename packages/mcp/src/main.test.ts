/**
 * D5 fail-closed startup battery: the stdio entry must exit NON-ZERO with
 * zero tools registered when authentication fails or the environment is
 * incomplete — never fall back to an ambient/default session. Runs main.ts as
 * a real subprocess. All tokens are synthetic garbage built at runtime.
 */
import { describe, expect, test } from "bun:test";

const ENTRY = new URL("main.ts", import.meta.url).pathname;

interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runMain(env: Record<string, string>): Promise<RunOutcome> {
  const proc = Bun.spawn(["bun", ENTRY], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    DB_HOST_PORT: process.env.DB_HOST_PORT ?? ""
  };
}

describe("bonfire-mcp startup (fail-closed)", () => {
  test("an unverifiable token exits non-zero and serves NOTHING on stdout", async () => {
    const outcome = await runMain({
      ...baseEnv(),
      BONFIRE_TOKEN: ["not", "a", "jwt"].join("."),
      BONFIRE_ISSUER: "https://idp.synthetic.test/",
      BONFIRE_JWKS_URI: "https://idp.synthetic.test/jwks.json",
      BONFIRE_AUDIENCE: "bonfire-synthetic"
    });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("authentication failed");
    expect(outcome.stderr).toContain("no tools registered");
    expect(outcome.stdout).toBe("");
  });

  test("a missing token config exits non-zero before any session exists", async () => {
    const outcome = await runMain(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("invalid environment");
    expect(outcome.stdout).toBe("");
  });
});
