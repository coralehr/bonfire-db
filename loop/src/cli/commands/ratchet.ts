/**
 * `loop ratchet` — enforce the memory closure invariant (T4).
 *
 * Default mode CHECKS: the KB must parse (malformed → loud fail), every guarded
 * entry's guard must exist and be proven, and the generated RATCHET.md must not
 * have drifted from the KB. `--write` regenerates the doc (like `gen:agents`).
 * Exit 1 on any violation — reopened bugs must never pass silently.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RatchetReport } from "../../memory/index.js";
import {
  checkRatchet,
  checkRatchetDocDrift,
  RATCHET_DOC_FILE,
  renderRatchetDoc
} from "../../memory/index.js";
import { ExitCode } from "../exit-codes.js";
import type { CliIO } from "../io.js";
import { resolveRepoRoot } from "../repo.js";

interface RatchetValues {
  readonly write: boolean;
  readonly json: boolean;
}

function renderHuman(io: CliIO, report: RatchetReport, drifted: boolean): void {
  for (const violation of report.violations) {
    io.stderr(`✗ ${violation.id}: ${violation.problem}\n`);
  }
  if (drifted) {
    io.stderr(`✗ ${RATCHET_DOC_FILE} drifted from the KB — run \`loop ratchet --write\`\n`);
  }
  for (const entry of report.entries.filter((e) => e.status === "open")) {
    io.stderr(`- ${entry.id} ${entry.class} is OPEN — owed: ${entry.plannedGuard ?? "?"}\n`);
  }
  const ok = report.ok && !drifted;
  const tally = `${String(report.guarded)} guarded, ${String(report.open)} open, ${String(report.retired)} retired`;
  io.stderr(`${ok ? "✓" : "✗"} ratchet ${ok ? "OK" : "FAIL"} — ${tally}\n`);
}

export function runRatchetCommand(io: CliIO, args: readonly string[]): number {
  let values: RatchetValues;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false }
      },
      allowPositionals: false,
      strict: true
    }));
  } catch (error) {
    io.stderr(`loop ratchet: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.USAGE;
  }

  const repoRoot = resolveRepoRoot(io.cwd);
  if (repoRoot === null) {
    io.stderr("loop ratchet: not inside a git repository\n");
    return ExitCode.USAGE;
  }

  const checked = checkRatchet(repoRoot);
  if (!checked.ok) {
    io.stderr("loop ratchet: the bug-patterns KB is malformed (memory must never load dirty):\n");
    for (const issue of checked.error.issues) io.stderr(`  ${issue}\n`);
    return ExitCode.FAILURE;
  }
  const report = checked.value;

  if (values.write) {
    writeFileSync(join(repoRoot, RATCHET_DOC_FILE), renderRatchetDoc(report.entries), "utf8");
    io.stderr(`wrote ${RATCHET_DOC_FILE}\n`);
  }
  const drifted = !checkRatchetDocDrift(repoRoot, report.entries);

  if (values.json) {
    const payload = {
      command: "ratchet",
      ok: report.ok && !drifted,
      guarded: report.guarded,
      open: report.open,
      retired: report.retired,
      violations: report.violations,
      docDrifted: drifted
    };
    io.stdout(`${JSON.stringify(payload)}\n`);
  } else {
    renderHuman(io, report, drifted);
  }

  return report.ok && !drifted ? ExitCode.OK : ExitCode.FAILURE;
}
