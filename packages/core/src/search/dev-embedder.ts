/**
 * The v0 default embedder: deterministic node:crypto feature-hashing, zero deps,
 * zero egress. Each token is SHA-256 hashed to a bucket + sign, accumulated, then
 * L2-normalized — so cosine similarity approximates hashed-token overlap. This is
 * the self-hosted, in-process model behind the no-egress security floor (BP-035):
 * the query text never leaves the box. A real model swaps in behind the same
 * `EmbeddingProvider` interface without a schema change (re-embed under a new
 * `modelId`).
 */
import { createHash } from "node:crypto";
import { EMBEDDING_DIM, type EmbeddingProvider } from "./schemas.js";

/** Stored on every vector; scopes each read to one embedding space. */
export const DEV_MODEL_ID = "dev-hash-v1";

const BUCKET_BYTE_OFFSET = 0;
const SIGN_BYTE_OFFSET = 4;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export const devEmbedder: EmbeddingProvider = {
  modelId: DEV_MODEL_ID,
  dimension: EMBEDDING_DIM,
  embed(text: string): Promise<number[]> {
    const v = new Float64Array(EMBEDDING_DIM);
    for (const tok of tokenize(text)) {
      const h = createHash("sha256").update(tok).digest();
      const bucket = h.readUInt32BE(BUCKET_BYTE_OFFSET) % EMBEDDING_DIM;
      const sign = (h[SIGN_BYTE_OFFSET] ?? 0) & 1 ? 1 : -1;
      v[bucket] = (v[bucket] ?? 0) + sign;
    }
    let sumSquares = 0;
    for (const x of v) sumSquares += x * x;
    const norm = Math.sqrt(sumSquares) || 1;
    return Promise.resolve(Array.from(v, (x) => x / norm));
  }
};

/** True when the text has no hashable token — its embedding is the zero vector. */
export function isZeroEmbedding(vector: readonly number[]): boolean {
  return vector.every((x) => x === 0);
}
