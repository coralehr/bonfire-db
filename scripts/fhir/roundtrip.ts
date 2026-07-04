/**
 * fhir:roundtrip — the lossless-or-ledgered gate (ratchet BP-008). For every
 * conformant golden: typed→FHIR→typed must be structurally identical, and any
 * decimal-scale normalization in the raw file must be covered by a loss-ledger
 * entry whose ADR exists. A round-trip diff with no ADR-backed ledger entry FAILS.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decimalDiffs,
  evaluateRoundTrip,
  fromFhir,
  parseJsonValue,
  parseLossLedger,
  type RoundTripDiff,
  roundTrip,
  structuralDiffs,
  toFhir,
  toJsonObject
} from "../../packages/core/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, "fixtures", "golden");
const LEDGER_FILE = join(REPO_ROOT, "docs", "loss-ledger.md");
const ADR_DIR = join(REPO_ROOT, "docs", "adr");
const PLANTED_MARKER = "-bad-";
const EXIT_OK = 0;
const EXIT_FAIL = 1;

function knownAdrs(): string[] {
  return readdirSync(ADR_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/adr/${name}`);
}

function diffsForGolden(file: string): RoundTripDiff[] {
  const raw = readFileSync(join(GOLDEN_DIR, file), "utf8");
  const content = toJsonObject(parseJsonValue(raw));
  const recovered = fromFhir(content);
  if (!recovered.ok)
    throw new Error(`${file}: golden is not mappable (${recovered.error.message})`);
  const input = recovered.data;
  const trip = roundTrip(input);
  if (!trip.recovered.ok) throw new Error(`${file}: round-trip did not recover the input`);
  const type = input.resourceType;
  // (A) typed round-trip: fromFhir(toFhir(input)) must equal the input.
  const typed = structuralDiffs(type, toJsonObject(input), toJsonObject(trip.recovered.data));
  // (B) FHIR-first idempotence: toFhir(fromFhir(golden)) must equal the golden.
  const fhirFirst = structuralDiffs(type, content, toFhir(input));
  // (C) wire-byte decimal-scale normalization detected from the raw golden text.
  return [...typed, ...fhirFirst, ...decimalDiffs(type, raw)];
}

function main(): number {
  const goldens = readdirSync(GOLDEN_DIR).filter(
    (name) => name.endsWith(".json") && !name.includes(PLANTED_MARKER)
  );
  const diffs = goldens.flatMap(diffsForGolden);
  const evaluation = evaluateRoundTrip({
    diffs,
    ledger: parseLossLedger(readFileSync(LEDGER_FILE, "utf8")),
    knownAdrs: knownAdrs()
  });
  for (const diff of diffs) {
    process.stdout.write(
      `round-trip diff ${diff.resourceType}${diff.pointer} [${diff.kind}] ${diff.detail}\n`
    );
  }
  if (!evaluation.ok) {
    for (const violation of evaluation.violations) {
      process.stderr.write(
        `UNLEDGERED ${violation.diff.resourceType}${violation.diff.pointer} — ${violation.reason}\n`
      );
    }
    return EXIT_FAIL;
  }
  process.stdout.write(
    `fhir:roundtrip: ${String(goldens.length)} goldens lossless-or-ledgered (${String(diffs.length)} ledgered diff(s))\n`
  );
  return EXIT_OK;
}

process.exitCode = main();
