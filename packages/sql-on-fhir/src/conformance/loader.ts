/**
 * Fail-closed loader for the vendored conformance suite. Every suite file is
 * re-hashed against the pinned MANIFEST.json sha256 and its case count is
 * re-counted from the parsed JSON — a tampered byte, a dropped case, or an
 * extra file is a typed error, never a silently smaller run (fake-conformance
 * control).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { SuiteError } from "../errors.js";
import type { SuiteFile, SuiteManifest } from "./suite-schema.js";
import { manifestSchema, suiteFileSchema } from "./suite-schema.js";

export interface LoadedSuiteFile {
  readonly name: string;
  readonly file: SuiteFile;
}

export interface LoadedSuite {
  readonly manifest: SuiteManifest;
  readonly files: readonly LoadedSuiteFile[];
  /** Cases re-counted from the parsed files, independent of the manifest. */
  readonly recountedCases: number;
}

function readManifest(suiteDir: string): Result<SuiteManifest, SuiteError> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(suiteDir, "MANIFEST.json"), "utf8"));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ code: "SUITE_FILE_INVALID", message: `cannot read MANIFEST.json: ${message}` });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ code: "SUITE_FILE_INVALID", message: "MANIFEST.json failed schema validation" });
  }
  return ok(parsed.data);
}

function loadSuiteFile(
  suiteDir: string,
  name: string,
  expected: { readonly sha256: string; readonly cases: number }
): Result<LoadedSuiteFile, SuiteError> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(suiteDir, "tests", name));
  } catch (_cause) {
    return err({ code: "SUITE_MANIFEST_MISMATCH", message: `suite file missing: ${name}` });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) {
    return err({
      code: "SUITE_FILE_TAMPERED",
      message: `sha256 mismatch for ${name}: vendored bytes differ from the pinned manifest`
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (_cause) {
    return err({ code: "SUITE_FILE_INVALID", message: `suite file is not JSON: ${name}` });
  }
  const parsed = suiteFileSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ code: "SUITE_FILE_INVALID", message: `suite file failed schema: ${name}` });
  }
  if (parsed.data.tests.length !== expected.cases) {
    return err({
      code: "SUITE_MANIFEST_MISMATCH",
      message: `${name} holds ${String(parsed.data.tests.length)} cases; manifest pins ${String(expected.cases)}`
    });
  }
  return ok({ name, file: parsed.data });
}

/** Load and integrity-check the whole vendored suite from `suiteDir`. */
export function loadSuite(suiteDir: string): Result<LoadedSuite, SuiteError> {
  const manifest = readManifest(suiteDir);
  if (!manifest.ok) return manifest;
  const names = Object.keys(manifest.data.files).sort();
  const onDisk = readdirSync(join(suiteDir, "tests"))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  if (onDisk.join(",") !== names.join(",")) {
    return err({
      code: "SUITE_MANIFEST_MISMATCH",
      message: "suite directory listing does not match the pinned manifest file set"
    });
  }
  if (names.length !== manifest.data.totalFiles) {
    return err({
      code: "SUITE_MANIFEST_MISMATCH",
      message: "manifest totalFiles disagrees with its own file map"
    });
  }
  const files: LoadedSuiteFile[] = [];
  let recountedCases = 0;
  for (const name of names) {
    const expected = manifest.data.files[name];
    if (expected === undefined) {
      return err({ code: "SUITE_MANIFEST_MISMATCH", message: `manifest entry vanished: ${name}` });
    }
    const loaded = loadSuiteFile(suiteDir, name, expected);
    if (!loaded.ok) return loaded;
    files.push(loaded.data);
    recountedCases += loaded.data.file.tests.length;
  }
  if (recountedCases !== manifest.data.totalCases) {
    return err({
      code: "SUITE_MANIFEST_MISMATCH",
      message: `recounted ${String(recountedCases)} cases; manifest pins ${String(manifest.data.totalCases)}`
    });
  }
  return ok({ manifest: manifest.data, files, recountedCases });
}
