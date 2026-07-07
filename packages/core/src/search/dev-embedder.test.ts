/**
 * Pure unit tests for the dev embedder: determinism, dimension, zero-vector
 * handling, and the empirical R3 collision property the fusion suite relies on
 * (a ratchet — if the hashing changes, the paraphrase pair stops overlapping and
 * this fails loudly rather than silently zeroing the vector arm).
 */
import { describe, expect, test } from "bun:test";
import { devEmbedder, isZeroEmbedding } from "./dev-embedder.js";
import { EMBEDDING_DIM } from "./schemas.js";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

describe("devEmbedder", () => {
  test("is deterministic and 384-dimensional", async () => {
    const first = await devEmbedder.embed("hello clinical world");
    const second = await devEmbedder.embed("hello clinical world");
    expect(first).toEqual(second);
    expect(first.length).toBe(EMBEDDING_DIM);
    expect(devEmbedder.dimension).toBe(EMBEDDING_DIM);
    expect(devEmbedder.modelId).toBe("dev-hash-v1");
  });

  test("a non-empty text is L2-normalized (unit length)", async () => {
    const v = await devEmbedder.embed("aspirin oral tablet");
    expect(cosine(v, v)).toBeCloseTo(1, 6);
    expect(isZeroEmbedding(v)).toBe(false);
  });

  test("a token-free text embeds to the zero vector (lexical-only guard)", async () => {
    const v = await devEmbedder.embed("!!! ??? ---");
    expect(isZeroEmbedding(v)).toBe(true);
  });

  test("R3: the paraphrase pair overlaps semantically while sharing NO lexeme", async () => {
    const docText = "syntok0 syntok1 syntok2 syntok3 syntok4 syntok5";
    const queryText = "syntok682 syntok431 syntok954 syntok235 syntok275";
    const shared = docText.split(" ").filter((w) => queryText.split(" ").includes(w));
    expect(shared).toEqual([]);
    const similarity = cosine(await devEmbedder.embed(docText), await devEmbedder.embed(queryText));
    expect(similarity).toBeGreaterThan(0.5);
  });
});
