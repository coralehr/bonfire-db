/**
 * The loss ledger: the ONLY sanctioned way a field may differ across a
 * round-trip. `parseLossLedger` reads the machine-checkable JSON block embedded
 * in docs/loss-ledger.md; `evaluateRoundTrip` fails unless EVERY diff is matched
 * by an entry AND that entry references an ADR that actually exists on disk —
 * so a lossy mapping without an ADR-backed sign-off can never pass (BP-008).
 */
import { z } from "zod";
import type { RoundTripDiff } from "./roundtrip-diff.js";

const ledgerEntrySchema = z.strictObject({
  resourceType: z.string().min(1),
  pointer: z.string().min(1),
  reason: z.string().min(1),
  adr: z.string().min(1)
});

export type LossLedgerEntry = z.infer<typeof ledgerEntrySchema>;

const LEDGER_JSON_BLOCK = /```json\s*([\s\S]*?)```/;

/** Extract the structured entries from a loss-ledger markdown document. */
export function parseLossLedger(markdown: string): LossLedgerEntry[] {
  const match = LEDGER_JSON_BLOCK.exec(markdown);
  const block = match?.[1];
  if (block === undefined || block.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(block);
  const result = z.array(ledgerEntrySchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("docs/loss-ledger.md json block is malformed");
  }
  return [...result.data];
}

export interface RoundTripViolation {
  readonly diff: RoundTripDiff;
  readonly reason: string;
}

export interface RoundTripEvaluation {
  readonly ok: boolean;
  readonly violations: readonly RoundTripViolation[];
}

export interface RoundTripEvaluationInput {
  readonly diffs: readonly RoundTripDiff[];
  readonly ledger: readonly LossLedgerEntry[];
  readonly knownAdrs: readonly string[];
}

/** Every diff must be covered by a ledger entry whose ADR exists (else deny). */
export function evaluateRoundTrip(input: RoundTripEvaluationInput): RoundTripEvaluation {
  const knownAdrs = new Set(input.knownAdrs);
  const violations: RoundTripViolation[] = [];
  for (const diff of input.diffs) {
    const entry = input.ledger.find(
      (candidate) =>
        candidate.resourceType === diff.resourceType && candidate.pointer === diff.pointer
    );
    if (entry === undefined) {
      violations.push({ diff, reason: "no loss-ledger entry covers this round-trip diff" });
    } else if (!knownAdrs.has(entry.adr)) {
      violations.push({ diff, reason: `loss-ledger entry references missing ADR ${entry.adr}` });
    }
  }
  return { ok: violations.length === 0, violations };
}
