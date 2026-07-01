import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendTransition, currentStates, readLedger } from "./state-ledger.js";

function tmpLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "ledger-")), "state.jsonl");
}

function transition(slice: string, state: "inbox" | "active" | "done" | "failed", actor = "test") {
  return { ts: new Date().toISOString(), slice, state, actor };
}

describe("state ledger — CRUD + tolerant read", () => {
  test("append then read round-trips; a missing file is an empty ledger", () => {
    const ledger = tmpLedger();
    expect(readLedger(ledger)).toEqual({ entries: [], dropped: 0 });
    appendTransition(ledger, transition("BF-01", "active"));
    appendTransition(ledger, transition("BF-01", "done"));
    const { entries, dropped } = readLedger(ledger);
    expect(entries).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  test("an invalid transition throws (never a silently dropped write)", () => {
    expect(() => appendTransition(tmpLedger(), transition("NOT-A-SLICE", "active"))).toThrow();
  });

  test("an oversized note is rejected before it can tear the file", () => {
    const big = { ...transition("BF-01", "active"), note: "x".repeat(5000) };
    expect(() => appendTransition(tmpLedger(), big)).toThrow("bytes");
  });

  test("a torn trailing line is dropped by the reader and repaired by the writer", () => {
    const ledger = tmpLedger();
    appendTransition(ledger, transition("BF-01", "active"));
    appendFileSync(ledger, '{"ts":"2026-07-02T00:00:00Z","slice":"BF-0'); // crash mid-write
    const torn = readLedger(ledger);
    expect(torn.entries).toHaveLength(1);
    expect(torn.dropped).toBe(1);
    appendTransition(ledger, transition("BF-02", "active")); // writer truncates the torn tail
    const repaired = readLedger(ledger);
    expect(repaired.entries).toHaveLength(2);
    expect(repaired.dropped).toBe(0);
  });

  test("currentStates folds to the LAST transition per slice, in append order", () => {
    const ledger = tmpLedger();
    appendTransition(ledger, transition("BF-01", "active"));
    appendTransition(ledger, transition("BF-02", "active"));
    appendTransition(ledger, transition("BF-01", "failed"));
    const states = currentStates(readLedger(ledger).entries);
    expect(states.get("BF-01")?.state).toBe("failed");
    expect(states.get("BF-02")?.state).toBe("active");
    expect(states.has("BF-03")).toBe(false);
  });
});

function runWorker(script: string, ledger: string, actor: string, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", script, ledger, actor, String(count)], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

describe("state ledger — concurrent-append safety (no lost writes)", () => {
  test("4 parallel processes x 25 appends = exactly 100 complete, distinct lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-conc-"));
    const ledger = join(dir, "state.jsonl");
    const ledgerModule = join(dirname(fileURLToPath(import.meta.url)), "state-ledger.ts");
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      [
        `import { appendTransition } from ${JSON.stringify(ledgerModule)};`,
        `const [ledger, actor, n] = process.argv.slice(2) as [string, string, string];`,
        `for (let i = 0; i < Number(n); i++) {`,
        `  appendTransition(ledger, {`,
        `    ts: new Date().toISOString(), slice: "BF-01", state: "active",`,
        `    actor: actor + "-" + String(i)`,
        `  });`,
        `}`
      ].join("\n")
    );

    const codes = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((name) => runWorker(worker, ledger, name, 25))
    );
    expect(codes).toEqual([0, 0, 0, 0]);

    const { entries, dropped } = readLedger(ledger);
    expect(dropped).toBe(0);
    expect(entries).toHaveLength(100);
    expect(new Set(entries.map((e) => e.actor)).size).toBe(100);
  }, 20_000);
});
