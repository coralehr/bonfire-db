import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lock-")), "file.jsonl");
}

describe("withFileLock", () => {
  test("acquires, runs, and releases (a second acquire succeeds immediately)", () => {
    const file = tmpFile();
    expect(withFileLock(file, () => "first")).toBe("first");
    expect(withFileLock(file, () => "second")).toBe("second");
  });

  test("releases the lock even when fn throws", () => {
    const file = tmpFile();
    expect(() =>
      withFileLock(file, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(withFileLock(file, () => "after")).toBe("after");
  });

  test("a LIVE holder blocks until timeout (fail-closed, never a lost write)", () => {
    const file = tmpFile();
    const lockDir = `${file}.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }));
    expect(() => withFileLock(file, () => "never", { timeoutMs: 150, staleMs: 60_000 })).toThrow(
      "could not acquire"
    );
  });

  test("a STALE lock (old mtime + dead pid) is recovered by re-contending", () => {
    const file = tmpFile();
    const lockDir = `${file}.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 99_999_999 }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockDir, past, past);
    expect(withFileLock(file, () => "recovered", { timeoutMs: 1000, staleMs: 100 })).toBe(
      "recovered"
    );
  });
});
