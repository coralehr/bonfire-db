/**
 * Semantic synthetic-only scanner CLI (BF-02 tripwire) — DENY-BY-DEFAULT (BP-022).
 *
 *   bun run scan:synthetic          self-test on the planted corpus, then sweep
 *                                   EVERY tracked text file (reviewed carve-outs only)
 *   bun run scan:synthetic <paths>  scan explicit repo-relative paths instead
 *                                   (pointing it at the planted fixture must exit 1)
 *
 * Two-tier detection: files that parse as JSON/NDJSON get the FHIR field-aware
 * detectors (unless FIELD_AWARE_EXEMPT); every text file also gets a text-mode
 * dashed-SSN pass. Exit contract: 0 = clean, 1 = findings, 2 = operational error.
 * The self-test runs FIRST and exits 2 unless every signal class fires — a scan
 * can only pass after proving the tripwire is alive; a crash never exits 0.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf, loadBaseline } from "./baseline.js";
import {
  BASELINE_FILE,
  EXCLUDED_PATHS,
  FIELD_AWARE_EXEMPT,
  PLANTED_FIXTURE_DIR,
  type ScopeEntry
} from "./config.js";
import type { Finding } from "./detectors.js";
import { ALL_RULES, isPlainObject, scanResource, scanText } from "./detectors.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_OPERATIONAL = 2;
const HASH_PREVIEW_LENGTH = 12;

interface FileFinding {
  readonly file: string;
  readonly finding: Finding;
}

/** repo-relative path is under (or equals) a carve-out entry. */
function matches(rel: string, entries: readonly ScopeEntry[]): boolean {
  return entries.some((e) => rel === e.path || rel.startsWith(`${e.path}/`));
}

// JSON.parse error messages embed a snippet of the source text; the scanner is
// pointed at SUSPECT content, so a parse of a NON-JSON file must never surface it.
function tryParseResources(text: string, isNdjson: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  try {
    if (isNdjson) {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        const raw: unknown = JSON.parse(line);
        if (isPlainObject(raw)) out.push(raw);
      }
      return out;
    }
    const raw: unknown = JSON.parse(text);
    if (isPlainObject(raw)) out.push(raw);
  } catch {
    return []; // not JSON -> text-mode only, no field-aware pass
  }
  return out;
}

/** Scan one file: text-mode dashed-SSN always; FHIR field-aware when requested + parseable. */
function scanOneFile(fileAbs: string, fieldAware: boolean): Finding[] {
  const buf = readFileSync(fileAbs);
  if (buf.includes(0)) return []; // binary (null byte) — skip
  const text = buf.toString("utf8");
  const findings: Finding[] = [...scanText(text)];
  if (fieldAware) {
    for (const resource of tryParseResources(text, fileAbs.endsWith(".ndjson"))) {
      findings.push(...scanResource(resource, ""));
    }
  }
  return findings;
}

function listFilesUnder(dirAbs: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const full = join(dirAbs, entry.name);
    if (entry.isDirectory()) files.push(...listFilesUnder(full));
    else files.push(full);
  }
  return files.sort();
}

/** Every tracked text file the sweep covers (deny-by-default minus EXCLUDED_PATHS + binary). */
export function enumerateTargets(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  })
    .split("\0")
    .filter((f) => f.length > 0);
  const targets: string[] = [];
  for (const rel of tracked) {
    if (matches(rel, EXCLUDED_PATHS)) continue;
    const abs = join(REPO_ROOT, rel);
    // git ls-files lists a locally deleted-but-unstaged path; skip if absent
    // (CI's clean checkout never hits this).
    if (!existsSync(abs)) continue;
    if (readFileSync(abs).includes(0)) continue; // binary (null byte)
    targets.push(rel);
  }
  return targets.sort();
}

function sweep(): FileFinding[] {
  const results: FileFinding[] = [];
  for (const rel of enumerateTargets()) {
    const fieldAware = !matches(rel, FIELD_AWARE_EXEMPT);
    for (const finding of scanOneFile(join(REPO_ROOT, rel), fieldAware)) {
      results.push({ file: rel, finding });
    }
  }
  return results;
}

/** Every signal class must fire on the planted corpus (json + txt); returns the misses. */
function selfTestMissingRules(): string[] {
  const fired = new Set<string>();
  for (const fileAbs of listFilesUnder(join(REPO_ROOT, PLANTED_FIXTURE_DIR))) {
    for (const finding of scanOneFile(fileAbs, true)) {
      fired.add(finding.rule);
    }
  }
  return ALL_RULES.filter((rule) => !fired.has(rule));
}

// JSON.parse error messages embed a snippet of the source text (BP-017). When the
// caller EXPLICITLY names a file as a resource to scan, malformed JSON is a real
// operational error — surface the LOCATION only, never the content.
function parseResourcesStrict(
  text: string,
  isNdjson: boolean,
  where: string
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = isNdjson ? text.split("\n") : [text];
  lines.forEach((line, index) => {
    if (isNdjson && line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      const at = isNdjson ? `${where}:${String(index + 1)}` : where;
      throw new Error(`invalid JSON in ${at} (content not shown)`);
    }
    if (isPlainObject(raw)) out.push(raw);
  });
  return out;
}

/** Explicit-path mode: text-mode always + STRICT field-aware (malformed JSON -> redacted error). */
function scanExplicit(paths: readonly string[]): FileFinding[] {
  const results: FileFinding[] = [];
  for (const arg of paths) {
    const fileAbs = resolve(REPO_ROOT, arg);
    const rel = relative(REPO_ROOT, fileAbs);
    const buf = readFileSync(fileAbs);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const findings: Finding[] = [...scanText(text)];
    for (const resource of parseResourcesStrict(text, fileAbs.endsWith(".ndjson"), rel)) {
      findings.push(...scanResource(resource, ""));
    }
    for (const finding of findings) results.push({ file: rel, finding });
  }
  return results;
}

function reportFindings(findings: readonly FileFinding[]): void {
  console.error(`scan:synthetic BLOCKED — ${String(findings.length)} finding(s):`);
  for (const { file, finding } of findings) {
    const preview = finding.valueSha256.slice(0, HASH_PREVIEW_LENGTH);
    console.error(`  [${finding.rule}] ${file}${finding.pointer} value-sha256=${preview}`);
  }
}

function main(argv: readonly string[]): number {
  try {
    // Coverage introspection for the BP-022 guard: print the exact swept set so a
    // test can assert `git ls-files` minus this equals only the reviewed carve-outs.
    if (argv[0] === "--list-targets") {
      process.stdout.write(`${enumerateTargets().join("\n")}\n`);
      return EXIT_CLEAN;
    }
    const missing = selfTestMissingRules();
    if (missing.length > 0) {
      console.error(`self-test FAILED — classes missing: ${missing.join(", ")}`);
      return EXIT_OPERATIONAL;
    }
    const total = ALL_RULES.length;
    console.log(`self-test: ${String(total)}/${String(total)} signal classes fired`);
    const raw = argv.length > 0 ? scanExplicit(argv) : sweep();
    const scannedCount = argv.length > 0 ? argv.length : enumerateTargets().length;
    const baseline = loadBaseline(join(REPO_ROOT, BASELINE_FILE));
    const findings = raw.filter(({ file, finding }) => !baseline.has(fingerprintOf(file, finding)));
    if (findings.length > 0) {
      reportFindings(findings);
      return EXIT_FINDINGS;
    }
    console.log(`scan:synthetic clean — ${String(scannedCount)} file(s) scanned, 0 findings`);
    return EXIT_CLEAN;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    console.error(`scan:synthetic operational error: ${detail}`);
    return EXIT_OPERATIONAL;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
