/**
 * The STATIC propose-only tool allowlist (security units U1 + U4): exactly
 * three tools — search_clinical, get_context, propose_resource. There is NO
 * raw SQL, FHIRPath, shell, or filesystem tool and NO approve/commit tool
 * (BF-09 owns governance). Every input schema is a strict zod object (the MCP
 * transport rejects off-schema arguments BEFORE a handler runs), every handler
 * sees ONLY the session-bound SDK client, and every error maps to a fixed
 * static string — an underlying error message is never forwarded into a model
 * context.
 */
import type { FhirResourceRecord, SearchResponse } from "@bonfire/core";
import { PURPOSES_OF_USE, scribeInputSchema } from "@bonfire/core";
import type { BonfireClient } from "@bonfire/sdk";
import { z } from "zod";

/**
 * The ABAC purpose is PINNED to treatment — agents cannot select their own
 * purpose of use. Sourced from core's enum and typed against the literal so a
 * reorder of PURPOSES_OF_USE fails to compile instead of silently repinning.
 */
const TREATMENT_PURPOSE: "TREAT" = PURPOSES_OF_USE[0];

/** Mirrors core's search bounds (core re-validates; this bounds the boundary). */
const QUERY_MAX_CHARS = 2000;
const TOP_N_MAX = 100;

export type ToolName = "get_context" | "propose_resource" | "search_clinical";

export interface ToolTextContent {
  /** The transport's content blocks are open shapes; mirror that structurally. */
  [key: string]: unknown;
  type: "text";
  text: string;
}

/** The wire result shape (structurally a CallToolResult; no SDK import here). */
export interface ToolResult {
  /** Explicit index signature: CallToolResult is an open (passthrough) shape. */
  [key: string]: unknown;
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  readonly name: ToolName;
  readonly description: string;
  /** Strict zod object; the transport validates arguments PRE-handler. */
  readonly inputSchema: z.ZodType;
  /** Runs with ONLY the session-bound client in scope (D2); never throws. */
  run(client: BonfireClient, args: unknown): Promise<ToolResult>;
}

/**
 * Fixed code -> static text. NEVER forward error.message: core messages can
 * interpolate untrusted input (e.g. a zod path), and this text lands directly
 * in a model context (the BF-07 serializer-injection lesson).
 */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  INVALID_SCRIBE_INPUT: "the write input failed schema validation",
  MALFORMED_INPUT: "the context request was malformed",
  MCP_INVALID_ARGUMENTS: "tool arguments failed schema validation",
  SDK_UNEXPECTED: "the request failed unexpectedly",
  SEARCH_INVALID_INPUT: "the search request was malformed",
  SEARCH_NO_TENANT: "no tenant scope is bound",
  TENANT_TX_FAILED: "the tenant transaction failed"
};
const FALLBACK_ERROR_TEXT = "the request was denied or failed";

function errorResult(code: string): ToolResult {
  const detail = ERROR_TEXT[code] ?? FALLBACK_ERROR_TEXT;
  return {
    isError: true,
    content: [{ type: "text", text: `bonfire-mcp error ${code}: ${detail}` }],
    structuredContent: { error: { code } }
  };
}

/** Wrap a typed handler in a re-parse so a tool is safe even standalone. */
function defineTool<Schema extends z.ZodType>(spec: {
  name: ToolName;
  description: string;
  inputSchema: Schema;
  handler: (client: BonfireClient, args: z.output<Schema>) => Promise<ToolResult>;
}): ToolDef {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (client, args): Promise<ToolResult> => {
      const parsed = spec.inputSchema.safeParse(args);
      if (!parsed.success) return errorResult("MCP_INVALID_ARGUMENTS");
      return spec.handler(client, parsed.data);
    }
  };
}

const searchArgsSchema = z.strictObject({
  query: z.string().min(1).max(QUERY_MAX_CHARS),
  topN: z.number().int().min(1).max(TOP_N_MAX).optional()
});

/**
 * Fixed-format search rendering: EVERY field derived from stored data is
 * JSON.stringify-wrapped so an injected newline/heading stays one escaped
 * token (D3); counts are numbers rendered via String().
 */
function renderSearchText(response: SearchResponse): string {
  const lines = [
    `search: ${String(response.results.length)} hit(s), excludedByPolicy=${String(response.excludedByPolicy.count)}`
  ];
  for (const [index, hit] of response.results.entries()) {
    lines.push(
      `[${String(index + 1)}] type=${JSON.stringify(hit.resourceType)} id=${JSON.stringify(hit.resourceId)} path=${JSON.stringify(hit.citation.path)} rowHash=${JSON.stringify(hit.citation.rowHash)}`
    );
  }
  lines.push(
    `receipt: decision=${JSON.stringify(response.policyReceipt.decision)} practiceId=${JSON.stringify(response.policyReceipt.practiceId)} purposeOfUse=${JSON.stringify(response.policyReceipt.purposeOfUse)}`,
    `auditEventId=${JSON.stringify(response.auditEventId)}`
  );
  return lines.join("\n");
}

/** The ONE scoped read both read-tools share: purpose pinned, session subject. */
function scopedSearch(
  client: BonfireClient,
  args: z.output<typeof searchArgsSchema>
): ReturnType<BonfireClient["searchClinical"]> {
  return client.searchClinical({ ...args, purposeOfUse: TREATMENT_PURPOSE });
}

const searchClinicalTool = defineTool({
  name: "search_clinical",
  description:
    "Hybrid cited search over THIS session's practice records (scope applied before retrieval). Returns hits with citations plus the ABAC policy receipt and audit event id. The purpose of use is pinned server-side; other practices' rows are never returned.",
  inputSchema: searchArgsSchema,
  handler: async (client, args): Promise<ToolResult> => {
    const found = await scopedSearch(client, args);
    if (!found.ok) return errorResult(found.error.code);
    return {
      content: [{ type: "text", text: renderSearchText(found.data) }],
      structuredContent: found.data
    };
  }
});

const getContextTool = defineTool({
  name: "get_context",
  description:
    "Search THIS session's practice records and return a span-cited context projection (CCP) chained entirely server-side from the scoped search — the search response never round-trips through the caller. Every span cites its source resource, path, and audit hash.",
  inputSchema: searchArgsSchema,
  handler: async (client, args): Promise<ToolResult> => {
    const found = await scopedSearch(client, args);
    if (!found.ok) {
      return errorResult(found.error.code);
    }
    // The chain never leaves the server: the scoped search feeds buildCcp
    // directly (D4), so a forged/oversized response can't be injected here.
    const source = found.data;
    const built = await client.buildCcp({ response: source, purposeOfUse: TREATMENT_PURPOSE });
    if (!built.ok) return errorResult(built.error.code);
    const doc = built.data;
    return {
      // CcpDocument.text goes out VERBATIM: BF-07's serializer already
      // neutralizes injected newlines/forged spans; re-serializing here would
      // reopen that hole (D3). The text never repeats in structuredContent (D7).
      content: [{ type: "text", text: doc.text }],
      structuredContent: {
        version: doc.version,
        practiceId: doc.practiceId,
        generatedAt: doc.generatedAt,
        spans: doc.spans,
        excludedByPolicy: doc.excludedByPolicy,
        policyReceipt: source.policyReceipt,
        sourceAuditEventId: source.auditEventId,
        auditEventId: doc.auditEventId
      }
    };
  }
});

function renderWriteText(record: FhirResourceRecord): string {
  return [
    `wrote ${JSON.stringify(record.type)} id=${JSON.stringify(record.id)} versionId=${JSON.stringify(record.versionId)}`,
    "this resource is live in the practice's canonical FHIR store now"
  ].join("\n");
}

const proposeResourceTool = defineTool({
  name: "propose_resource",
  description:
    "Write one typed clinical resource into THIS session's practice canonical FHIR store. The write is live the moment this call returns — approve/commit governance (BF-09) does not exist yet. Input is a strict typed scribe resource; the practice is bound server-side from the session.",
  inputSchema: z.strictObject({ resource: scribeInputSchema }),
  handler: async (client, args): Promise<ToolResult> => {
    const written = await client.proposeResource(args.resource);
    if (!written.ok) return errorResult(written.error.code);
    const { record, terminology } = written.data;
    return {
      content: [{ type: "text", text: renderWriteText(record) }],
      structuredContent: {
        resourceType: record.type,
        id: record.id,
        versionId: record.versionId,
        terminology
      }
    };
  }
});

/**
 * EXACTLY three tools; iterating this array is the ONLY registration path.
 * Frozen so the allowlist is immutable at RUNTIME too, not merely `readonly`
 * to the type checker — an in-process consumer cannot push a fourth tool onto
 * the surface a session already registered.
 */
export const ALLOWLIST: readonly ToolDef[] = Object.freeze([
  searchClinicalTool,
  getContextTool,
  proposeResourceTool
]);
