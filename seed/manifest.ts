/**
 * Corpus manifest boundary: Zod schema, loader, and LF-normalized SHA-256
 * verification. The manifest is the seed's source of truth — a file that does
 * not hash to its manifest entry is a hard error, never a best-effort insert.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BonfireError, Result } from "@bonfire/core";
import { canonicalizeJson, err, jsonValueSchema, ok } from "@bonfire/core";
import { z } from "zod";

const manifestFileSchema = z.object({
  path: z.string().min(1),
  resourceType: z.string().min(1),
  count: z.number().int().positive(),
  sha256: z.string().min(1)
});

export const corpusManifestSchema = z.object({
  source: z.string().min(1),
  practices: z.tuple([z.uuid(), z.uuid()]),
  files: z.array(manifestFileSchema).min(1)
});

export type CorpusManifest = z.infer<typeof corpusManifestSchema>;
export type ManifestErrorCode = "MANIFEST_INVALID";

/** Normalize CRLF to LF so hashes agree across operating systems. */
export function normalizeLf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Content hash of the manifest itself — the seed_completions marker value. */
export function manifestHash(manifest: CorpusManifest): string {
  return sha256Hex(canonicalizeJson(jsonValueSchema.parse(manifest)));
}

export function loadManifest(
  manifestPath: string
): Result<CorpusManifest, BonfireError<ManifestErrorCode>> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unreadable file";
    return err({ code: "MANIFEST_INVALID", message: `cannot read manifest: ${detail}` });
  }
  const parsed = corpusManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ code: "MANIFEST_INVALID", message: "manifest does not match the schema" });
  }
  return ok(parsed.data);
}

export interface FileHashReport {
  readonly path: string;
  readonly resourceType: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly expectedCount: number;
  readonly actualCount: number;
}

/** Hash + line-count every corpus file (LF-normalized), against the manifest. */
export function reportFileHashes(fixturesDir: string, manifest: CorpusManifest): FileHashReport[] {
  return manifest.files.map((file) => {
    const text = normalizeLf(readFileSync(join(fixturesDir, file.path), "utf8"));
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return {
      path: file.path,
      resourceType: file.resourceType,
      expectedSha256: file.sha256,
      actualSha256: sha256Hex(text),
      expectedCount: file.count,
      actualCount: lines.length
    };
  });
}
