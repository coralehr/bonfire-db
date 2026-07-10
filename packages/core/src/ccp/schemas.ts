/**
 * CCP boundary types + Zod schemas. `ccpInputSchema` parses the ONE untrusted
 * request boundary — it reuses the exported `searchResponseSchema` for the
 * BF-06 response (no shape drift) plus the requesting subject and purpose.
 * `ccpDocumentSchema` re-validates the assembled document before it leaves
 * `buildCcp` (parse in AND out, the BF-06 precedent).
 */
import { z } from "zod";
import { PURPOSES_OF_USE, ROLES } from "../abac/types.js";
import { SHA256_HEX_LENGTH } from "../audit/row-hash.js";
import { searchResponseSchema } from "../search/schemas.js";

/** The CCP wire-format version tag every document carries. */
export const CCP_VERSION = "ccp/v1";

const ccpSubjectSchema = z.object({
  id: z.string().min(1),
  role: z.enum(ROLES),
  practiceId: z.uuid()
});

/**
 * The untrusted build request. The bound practice is NOT accepted here — it is
 * read from the tenant GUC inside `buildCcp` (T7), so the audited practice can
 * never diverge from the transaction the projection is built under.
 */
export const ccpInputSchema = z.object({
  response: searchResponseSchema,
  subject: ccpSubjectSchema,
  purposeOfUse: z.enum(PURPOSES_OF_USE)
});

export type CcpInput = z.infer<typeof ccpInputSchema>;

const spanValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** A projected leaf value — scalars only, enforced by the declared path table. */
export type CcpSpanValue = z.infer<typeof spanValueSchema>;

const ccpSpanSchema = z.object({
  resourceId: z.uuid(),
  resourceType: z.string().min(1),
  jsonPath: z.string().min(1),
  value: spanValueSchema,
  auditHash: z.string().length(SHA256_HEX_LENGTH),
  lastUpdated: z.string().min(1),
  versionId: z.string().min(1)
});

export type CcpSpan = z.infer<typeof ccpSpanSchema>;

/** A span before the audit append: everything but the auditHash it will carry. */
export type CcpSpanDraft = Omit<CcpSpan, "auditHash">;

export const ccpDocumentSchema = z.object({
  version: z.literal(CCP_VERSION),
  auditEventId: z.string().length(SHA256_HEX_LENGTH),
  practiceId: z.uuid(),
  generatedAt: z.string().min(1),
  spans: z.array(ccpSpanSchema),
  // Types + count only, never withheld row ids (BP-019) — the exact shape the
  // scoped search emitted, propagated without re-modelling.
  excludedByPolicy: searchResponseSchema.shape.excludedByPolicy,
  text: z.string().min(1)
});

export type CcpDocument = z.infer<typeof ccpDocumentSchema>;
