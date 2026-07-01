/**
 * The STATE ledger: the spine the loop reads/writes every run (H4/A5).
 *
 * An append-only JSONL file of slice state transitions
 * (inbox → active → done | failed). Concurrency model, per the June-2026
 * research pass:
 *   - CORRECTNESS: every write holds the zero-dep mkdir advisory lock
 *     (./file-lock.ts) — parallel same-machine writers cannot interleave.
 *   - DEFENSE-IN-DEPTH: one transition = ONE appendFileSync call of one
 *     `\n`-terminated line < 4KB (O_APPEND; a single small write is not split
 *     on local APFS/ext4), so even a lock failure cannot tear a record.
 *   - TORN-TAIL REPAIR: a crash mid-write can only damage the final line; the
 *     writer truncates back to the last `\n` before appending, and the reader
 *     tolerates (and counts) a torn trailing line instead of failing the file.
 *
 * The KB loader (./bug-pattern.ts) is strict where this reader is tolerant:
 * the ledger is high-churn machine output; the KB is curated memory.
 */
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SLICE_ID_PATTERN } from "../contracts/slice-contract.js";
import { withFileLock } from "./file-lock.js";

export const STATE_LEDGER_FILE = "loop/memory/state.jsonl";

export const sliceStateSchema = z.enum(["inbox", "active", "done", "failed"]);
export type SliceState = z.infer<typeof sliceStateSchema>;

export const stateTransitionSchema = z.strictObject({
  ts: z.iso.datetime(),
  slice: z.string().regex(SLICE_ID_PATTERN),
  state: sliceStateSchema,
  actor: z.string().min(1),
  note: z.string().min(1).optional()
});
export type StateTransition = z.infer<typeof stateTransitionSchema>;

export interface LedgerRead {
  readonly entries: readonly StateTransition[];
  /** Lines dropped by the tolerant reader (torn tail or malformed). */
  readonly dropped: number;
}

const MAX_LINE_BYTES = 4096;

export function stateLedgerPath(repoRoot: string): string {
  return join(repoRoot, STATE_LEDGER_FILE);
}

/** Truncate a torn tail (no trailing `\n`) back to the last complete line. */
function repairTornTail(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0) return;
  const content = readFileSync(path, "utf8");
  if (content.endsWith("\n")) return;
  const lastNewline = content.lastIndexOf("\n");
  truncateSync(
    path,
    lastNewline === -1 ? 0 : Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8")
  );
}

/**
 * Append one validated transition under the advisory lock. Throws on an invalid
 * transition or an oversized line — both are programmer errors, and a silently
 * dropped transition would be forgotten state.
 */
export function appendTransition(ledgerPath: string, transition: StateTransition): void {
  const parsed = stateTransitionSchema.parse(transition);
  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error(`ledger line exceeds ${String(MAX_LINE_BYTES)} bytes — keep notes short`);
  }
  withFileLock(ledgerPath, () => {
    repairTornTail(ledgerPath);
    appendFileSync(ledgerPath, line, "utf8");
  });
}

/** Tolerant read: a missing file is an empty ledger; bad lines are counted, not fatal. */
export function readLedger(ledgerPath: string): LedgerRead {
  if (!existsSync(ledgerPath)) return { entries: [], dropped: 0 };
  const entries: StateTransition[] = [];
  let dropped = 0;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = stateTransitionSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        entries.push(parsed.data);
      } else {
        dropped += 1;
      }
    } catch {
      dropped += 1;
    }
  }
  return { entries, dropped };
}

/**
 * Fold the ledger into each slice's CURRENT state: append order wins (the file
 * is chronological by construction). Slices with no transitions are implicitly
 * "inbox" — the caller merges against the registry for the full picture.
 */
export function currentStates(
  entries: readonly StateTransition[]
): ReadonlyMap<string, StateTransition> {
  const latest = new Map<string, StateTransition>();
  for (const entry of entries) latest.set(entry.slice, entry);
  return latest;
}
