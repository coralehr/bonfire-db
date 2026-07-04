/**
 * fhir:validate — run the official HL7 FHIR validator over the golden fixtures.
 * Conformant goldens must pass (exit 0); planted-violation goldens (`*-bad-*`)
 * must be REJECTED (non-zero), so this step proves the conformance gate fires in
 * BOTH directions — "FHIR-valid" is never assumed without the validator.
 * Fail-closed: a missing validator jar or absent Java exits non-zero.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, "fixtures", "golden");
const FHIR_VERSION = "4.0.1";
const US_CORE_IG = "hl7.fhir.us.core#6.1.0";
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const PLANTED_MARKER = "-bad-";

function runValidator(jar: string, files: readonly string[]): number {
  const args = [
    "-jar",
    jar,
    ...files,
    "-version",
    FHIR_VERSION,
    "-ig",
    US_CORE_IG,
    "-tx",
    "n/a",
    "-disable-default-resource-fetcher",
    "-output-style",
    "compact"
  ];
  const javaBin =
    process.env.JAVA_HOME === undefined ? "java" : `${process.env.JAVA_HOME}/bin/java`;
  const proc = spawnSync(javaBin, args, { encoding: "utf8" });
  if (proc.error !== undefined) return EXIT_FAIL;
  process.stdout.write(proc.stdout);
  process.stderr.write(proc.stderr);
  return proc.status ?? EXIT_FAIL;
}

function goldenFiles(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(GOLDEN_DIR, name));
}

function rejectPlanted(jar: string, planted: readonly string[]): boolean {
  for (const file of planted) {
    if (runValidator(jar, [file]) === EXIT_OK) {
      process.stderr.write(
        `fhir:validate: planted violation ${file} was NOT rejected — fake-conformance\n`
      );
      return false;
    }
    process.stdout.write(`fhir:validate: planted violation ${file} correctly rejected\n`);
  }
  return true;
}

function main(): number {
  const jar = process.env.BONFIRE_FHIR_VALIDATOR_JAR;
  if (jar === undefined || !existsSync(jar)) {
    process.stderr.write(
      "fhir:validate: BONFIRE_FHIR_VALIDATOR_JAR unset or missing — fail-closed\n"
    );
    return EXIT_FAIL;
  }
  const all = goldenFiles();
  const planted = all.filter((file) => file.includes(PLANTED_MARKER));
  const conformant = all.filter((file) => !file.includes(PLANTED_MARKER));
  if (runValidator(jar, conformant) !== EXIT_OK) {
    process.stderr.write("fhir:validate: conformant goldens FAILED validation\n");
    return EXIT_FAIL;
  }
  if (!rejectPlanted(jar, planted)) return EXIT_FAIL;
  process.stdout.write(
    `fhir:validate: ${String(conformant.length)} conformant valid, ${String(planted.length)} planted rejected\n`
  );
  return EXIT_OK;
}

process.exitCode = main();
