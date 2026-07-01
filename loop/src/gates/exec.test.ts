import { describe, expect, test } from "bun:test";
import { type CommandResult, commandDetail, failureReason, runCommand } from "./exec.js";

const CWD = process.cwd();

describe("runCommand — fail-closed (T1)", () => {
  test("a clean exit 0 is ok", () => {
    const r = runCommand(["sh", "-c", "exit 0"], { cwd: CWD });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.spawnError).toBeNull();
  });

  test("a non-zero exit is not ok, preserving the code", () => {
    const r = runCommand(["sh", "-c", "exit 3"], { cwd: CWD });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  test("a MISSING tool fails closed — never a pass", () => {
    const r = runCommand(["definitely-not-a-real-binary-9z9z"], { cwd: CWD });
    expect(r.ok).toBe(false);
    expect(r.spawnError).not.toBeNull();
  });

  test("an empty argv fails closed", () => {
    const r = runCommand([], { cwd: CWD });
    expect(r.ok).toBe(false);
    expect(r.spawnError).toBe("empty command");
  });

  test("captures combined output", () => {
    const r = runCommand(["sh", "-c", "printf hello"], { cwd: CWD });
    expect(r.output).toContain("hello");
  });
});

describe("commandDetail / failureReason", () => {
  const missing: CommandResult = { ok: false, exitCode: 127, output: "", spawnError: "boom" };
  const exited: CommandResult = { ok: false, exitCode: 2, output: "out", spawnError: null };
  const silent: CommandResult = { ok: false, exitCode: 1, output: "", spawnError: null };

  test("commandDetail prefers output, then spawnError, then fallback", () => {
    expect(commandDetail(exited, "fb")).toBe("out");
    expect(commandDetail(missing, "fb")).toBe("boom");
    expect(commandDetail(silent, "fb")).toBe("fb");
  });

  test("failureReason distinguishes a spawn error from an exit code", () => {
    expect(failureReason(missing)).toContain("could not run");
    expect(failureReason(exited)).toBe("exit 2");
  });
});
