/**
 * Cited-search boundary types + Zod schemas. `searchInputSchema` parses the ONE
 * untrusted request boundary; `searchResponseSchema` re-validates the assembled
 * response before it leaves `searchClinical` (acceptance #1: parse in AND out).
 * `policyReceiptSchema` is a local value-schema for the BF-05 receipt shape (abac
 * exposes only the type, no value schema) — the value it validates is a real
 * `PolicyReceipt`, so a widened `purposeOfUse: string` here still accepts it.
 */
import { z } from "zod";
import { PURPOSES_OF_USE, ROLES } from "../abac/types.js";
import { SHA256_HEX_LENGTH } from "../audit/row-hash.js";

/** The dev embedder's hashing dimension; the `vector(384)` column enforces it too. */
export const EMBEDDING_DIM = 384;
/** Bounds on the untrusted request (a huge query or topN is a DoS lever). */
export const MAX_SEARCH_QUERY_LENGTH = 2000;
export const MAX_SEARCH_TOP_N = 100;
/** Default page size when the caller does not pin `topN`. */
export const DEFAULT_TOP_N = 20;

/**
 * A pluggable embedding model. The v0 default (`dev-hash-v1`) is node:crypto
 * feature-hashing — self-hosted, in-process, zero egress. A real model swaps in
 * behind this interface; `modelId` scopes every read to one embedding space.
 */
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
}

/** Optional cross-encoder rerank stage (OFF by default; no impl ships in v0). */
export interface RerankProvider {
  rerank(hits: readonly SearchHit[]): Promise<readonly SearchHit[]>;
}

/** Injected dependencies (never untrusted input, so never Zod-parsed). */
export interface SearchConfig {
  readonly embedder?: EmbeddingProvider;
  readonly reranker?: RerankProvider;
  readonly now?: () => string;
}

const subjectSchema = z.object({
  id: z.string().min(1),
  role: z.enum(ROLES),
  practiceId: z.uuid()
});

/**
 * The untrusted search request. `requestPracticeId` is NOT accepted here — it is
 * read from the bound tenant GUC inside `searchClinical`, so the audited practice
 * can never diverge from the transaction it is written under.
 */
export const searchInputSchema = z.object({
  query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  subject: subjectSchema,
  purposeOfUse: z.enum(PURPOSES_OF_USE),
  topN: z.number().int().min(1).max(MAX_SEARCH_TOP_N).optional()
});

export type SearchInput = z.infer<typeof searchInputSchema>;

const citationSchema = z.object({
  resourceId: z.uuid(),
  path: z.string().min(1),
  rowHash: z.string().length(SHA256_HEX_LENGTH)
});

const freshnessSchema = z.object({
  lastUpdated: z.string().min(1),
  versionId: z.string().min(1)
});

const searchHitSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.uuid(),
  score: z.number(),
  citation: citationSchema,
  freshness: freshnessSchema
});

export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * A resource TYPE withheld by the scope filter, with its deny reason. Only types
 * (never row ids) are exposed — a withheld row id is a cross-tenant existence
 * oracle (BP-019).
 */
const excludedTypeSchema = z.object({
  resourceType: z.string().min(1),
  reason: z.string().min(1),
  matchedRuleId: z.string().nullable()
});

export type ExcludedType = z.infer<typeof excludedTypeSchema>;

/**
 * Validate the security-critical receipt fields (decision, bound tenant, purpose,
 * timestamp) and pass the descriptive fields (actorId, resourceType, matchedRuleId,
 * reason) through unchanged — the value is a trusted BF-05 PolicyReceipt built
 * in-process, so this boundary check guards the fields a consumer branches on.
 */
const policyReceiptSchema = z
  .object({
    decision: z.enum(["allow", "deny"]),
    practiceId: z.string(),
    purposeOfUse: z.string(),
    timestamp: z.string()
  })
  .catchall(z.unknown());

export const searchResponseSchema = z.object({
  results: z.array(searchHitSchema),
  excludedByPolicy: z.object({
    count: z.number().int().min(0),
    resourceTypes: z.array(excludedTypeSchema)
  }),
  policyReceipt: policyReceiptSchema,
  auditEventId: z.string().length(SHA256_HEX_LENGTH)
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;
