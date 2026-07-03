/**
 * Semantic synthetic-only scanner CLI (BF-02 tripwire).
 *
 *   bun run scan:synthetic          self-test on the planted fixture, then
 *                                   scan fixtures/synthetic/** (fixture excluded)
 *   bun run scan:synthetic <paths>  scan explicit repo-relative paths instead
 *                                   (pointing it at the planted fixture must exit 1)
 *
 * Exit contract: 0 = clean, 1 = findings, 2 = operational error. The self-test
 * runs FIRST on every invocation and exits 2 unless every signal class fires —
 * the scan can only ever pass after proving the tripwire is alive. A crash can
 * never exit 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf, loadBaseline } from "./baseline.js";
import {
  BASELINE_FILE,
  EXCLUDED_FILES,
  PLANTED_FIXTURE,
  SCAN_EXTENSIONS,
  SCAN_ROOTS
} from "./config.js";
import type { Finding } from "./detectors.js";
import { ALL_RULES, isPlainObject, scanResource } from "./detectors.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_OPERATIONAL = 2;
const HASH_PREVIEW_LENGTH = 12;

interface FileFinding {
  readonly file: string;
  readonly finding: Finding;
}

interface ParsedResource {
  readonly resource: Record<string, unknown>;
  readonly pointer: string;
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

function parseObject(raw: unknown, context: string): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error(`${context} is not a JSON object`);
  return raw;
}

// JSON.parse error messages embed a snippet of the source text. The scanner is
// pointed at SUSPECT files, so that snippet could be a real identifier — parse
// failures must surface the location only, never the content.
function parseJsonRedacted(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`invalid JSON in ${where} (content not shown)`);
  }
}

function parseResources(fileAbs: string): ParsedResource[] {
  const text = readFileSync(fileAbs, "utf8");
  const parsed: ParsedResource[] = [];
  if (fileAbs.endsWith(".ndjson")) {
    text.split("\n").forEach((line, index) => {
      if (line.trim().length === 0) return;
      const raw = parseJsonRedacted(line, `${fileAbs}:${String(index + 1)}`);
      parsed.push({
        resource: parseObject(raw, `${fileAbs}:${String(index + 1)}`),
        pointer: `/${String(index)}`
      });
    });
    return parsed;
  }
  const raw = parseJsonRedacted(text, fileAbs);
  return [{ resource: parseObject(raw, fileAbs), pointer: "" }];
}

function scanFiles(filesAbs: readonly string[]): FileFinding[] {
  const results: FileFinding[] = [];
  for (const fileAbs of filesAbs) {
    const file = relative(REPO_ROOT, fileAbs);
    for (const { resource, pointer } of parseResources(fileAbs)) {
      for (const finding of scanResource(resource, pointer)) {
        results.push({ file, finding });
      }
    }
  }
  return results;
}

/** Every signal class must fire on the planted fixture; returns the misses. */
function selfTestMissingRules(): string[] {
  const fired = new Set(
    scanFiles([join(REPO_ROOT, PLANTED_FIXTURE)]).map(({ finding }) => finding.rule)
  );
  return ALL_RULES.filter((rule) => !fired.has(rule));
}

function defaultTargets(): string[] {
  const targets: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const fileAbs of listFilesUnder(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, fileAbs);
      if (EXCLUDED_FILES.includes(rel)) continue;
      if (!SCAN_EXTENSIONS.includes(extname(fileAbs))) continue;
      targets.push(fileAbs);
    }
  }
  return targets;
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
    const missing = selfTestMissingRules();
    if (missing.length > 0) {
      console.error(`self-test FAILED — classes missing: ${missing.join(", ")}`);
      return EXIT_OPERATIONAL;
    }
    const total = ALL_RULES.length;
    console.log(`self-test: ${String(total)}/${String(total)} signal classes fired`);
    const explicit = argv.map((arg) => resolve(REPO_ROOT, arg));
    const targets = explicit.length > 0 ? explicit : defaultTargets();
    const baseline = loadBaseline(join(REPO_ROOT, BASELINE_FILE));
    const findings = scanFiles(targets).filter(
      ({ file, finding }) => !baseline.has(fingerprintOf(file, finding))
    );
    if (findings.length > 0) {
      reportFindings(findings);
      return EXIT_FINDINGS;
    }
    console.log(`scan:synthetic clean — ${String(targets.length)} file(s) scanned, 0 findings`);
    return EXIT_CLEAN;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    console.error(`scan:synthetic operational error: ${detail}`);
    return EXIT_OPERATIONAL;
  }
}

process.exitCode = main(process.argv.slice(2));
