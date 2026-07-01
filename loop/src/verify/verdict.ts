/**
 * The verifier VERDICT: schema + fail-closed parser (loop-harness-plan.md H4).
 *
 * The bonfire-verifier agent (loop/src/agents/defs/verifier.ts) must end its run
 * with a fixed text block: a `VERDICT:` line, then BLOCKING / NON-BLOCKING /
 * RUN THESE TO CONFIRM / ACCEPTANCE TRACE sections. This module is the harness
 * side of that contract — handoff validation. A verdict the loop cannot parse
 * AND validate is never trusted: `parseVerdict` returns an err Result, and the
 * caller must treat that as not-a-pass. The schema enforces the def's own
 * cross-field rules: BLOCKING is empty only on PASS, and PASS requires every
 * acceptance row to be PASS.
 */
import { z } from "zod";
import type { Result } from "../contracts/result.js";
import { err, ok } from "../contracts/result.js";

export const verdictStatusSchema = z.enum(["PASS", "FAIL", "NEEDS-HUMAN"]);
export type VerdictStatus = z.infer<typeof verdictStatusSchema>;

const nonEmptyString = z.string().min(1);

/** One ACCEPTANCE TRACE row: criterion — status — file:line evidence or command. */
export const acceptanceRowSchema = z.strictObject({
  criterion: nonEmptyString,
  status: verdictStatusSchema,
  evidence: nonEmptyString
});
export type AcceptanceRow = z.infer<typeof acceptanceRowSchema>;

export const verdictSchema = z
  .strictObject({
    verdict: verdictStatusSchema,
    blocking: z.array(nonEmptyString),
    nonBlocking: z.array(nonEmptyString),
    runTheseToConfirm: z.array(nonEmptyString),
    // The trace is the core artifact: every acceptance criterion, exactly once.
    acceptanceTrace: z.array(acceptanceRowSchema).min(1)
  })
  .refine((v) => v.verdict !== "PASS" || v.blocking.length === 0, {
    message: "a PASS verdict must have no BLOCKING findings"
  })
  .refine((v) => v.verdict !== "PASS" || v.acceptanceTrace.every((r) => r.status === "PASS"), {
    message: "a PASS verdict requires every acceptance row to be PASS"
  })
  .refine((v) => v.verdict === "PASS" || v.blocking.length > 0, {
    message: "a non-PASS verdict must name at least one BLOCKING finding"
  });
export type Verdict = z.infer<typeof verdictSchema>;

/** Why a verifier handoff was rejected. Callers must treat this as not-a-pass. */
export interface VerdictParseFailure {
  readonly issues: readonly string[];
}

const SECTION_HEADERS = [
  "BLOCKING",
  "NON-BLOCKING",
  "RUN THESE TO CONFIRM",
  "ACCEPTANCE TRACE"
] as const;
type SectionHeader = (typeof SECTION_HEADERS)[number];

const VERDICT_LINE = /^VERDICT:\s*(PASS|FAIL|NEEDS-HUMAN)\s*$/m;
const ITEM_LINE = /^(?:-|\d+\.)\s+(.*)$/;
/** Row separator: em-dash or pipe, space-padded ("criterion — STATUS — evidence"). */
const ROW_SEPARATOR = /\s+(?:—|\|)\s+/;
const EMPTY_MARKERS = new Set(["none", "(none)", "n/a", "—"]);

function splitSections(text: string): Map<SectionHeader, string[]> {
  const sections = new Map<SectionHeader, string[]>();
  let current: SectionHeader | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const header = SECTION_HEADERS.find((h) => line === h);
    if (header) {
      current = header;
      sections.set(header, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
  }
  return sections;
}

function parseItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const match = ITEM_LINE.exec(line);
    if (!match) continue;
    const item = (match[1] ?? "").trim();
    if (item.length === 0 || EMPTY_MARKERS.has(item.toLowerCase())) continue;
    items.push(item);
  }
  return items;
}

/** criterion — STATUS — evidence: three parts minimum. */
const MIN_ROW_PARTS = 3;

function parseTraceRow(item: string): AcceptanceRow | null {
  const parts = item.split(ROW_SEPARATOR);
  if (parts.length < MIN_ROW_PARTS) return null;
  const criterion = (parts[0] ?? "").trim();
  const statusToken = (parts[1] ?? "").trim();
  const evidence = parts.slice(2).join(" — ").trim();
  const status = verdictStatusSchema.safeParse(statusToken);
  if (!status.success || criterion.length === 0 || evidence.length === 0) return null;
  return { criterion, status: status.data, evidence };
}

function parseTrace(items: readonly string[]): { rows: AcceptanceRow[]; issues: string[] } {
  const rows: AcceptanceRow[] = [];
  const issues: string[] = [];
  for (const item of items) {
    const row = parseTraceRow(item);
    if (row === null) {
      issues.push(
        `unparseable ACCEPTANCE TRACE row (need "criterion — STATUS — evidence"): ${item}`
      );
    } else {
      rows.push(row);
    }
  }
  return { rows, issues };
}

function sectionItems(sections: Map<SectionHeader, string[]>, header: SectionHeader): string[] {
  return parseItems(sections.get(header) ?? []);
}

/**
 * Parse a verifier's raw final text into a validated Verdict. Fail-closed: any
 * missing section, malformed row, or cross-field violation is an err — the loop
 * must then route the slice to FAIL / NEEDS-HUMAN, never assume a pass.
 */
export function parseVerdict(text: string): Result<Verdict, VerdictParseFailure> {
  const issues: string[] = [];

  const statusToken = VERDICT_LINE.exec(text)?.[1] ?? "";
  if (statusToken === "") issues.push("no `VERDICT: PASS|FAIL|NEEDS-HUMAN` line found");

  const sections = splitSections(text);
  for (const header of SECTION_HEADERS) {
    if (!sections.has(header)) issues.push(`missing section: ${header}`);
  }
  if (issues.length > 0) return err({ issues });

  const trace = parseTrace(sectionItems(sections, "ACCEPTANCE TRACE"));
  if (trace.issues.length > 0) return err({ issues: trace.issues });

  const parsed = verdictSchema.safeParse({
    verdict: statusToken,
    blocking: sectionItems(sections, "BLOCKING"),
    nonBlocking: sectionItems(sections, "NON-BLOCKING"),
    runTheseToConfirm: sectionItems(sections, "RUN THESE TO CONFIRM"),
    acceptanceTrace: trace.rows
  });
  if (!parsed.success) {
    return err({ issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return ok(parsed.data);
}
