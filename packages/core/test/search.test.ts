/**
 * BF-06 TRACER 1 — hybrid fusion is REAL. Hermetic (BP-024): each test mints a
 * fresh random practice, seeds a synthetic corpus through the canonical write
 * path, and populates search_doc via the exported indexer (never an operator
 * runner). Asserts, on a LIVE fused search, that the lexical and vector arms each
 * contribute, that fusion combines them, and that the ranking is deterministic.
 * All data is synthetic. Runs as bonfire_app (RLS-subject).
 *
 * The collision tokens are empirically derived (R3): PARA_TOKENS and VEC_QUERY
 * share NO tsquery lexeme yet embed to overlapping hash buckets, so a VEC_QUERY
 * hit on the paraphrase doc can ONLY come from the vector arm.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "../src/db/canonical-json.js";
import { insertFhirResourceTx } from "../src/db/fhir-store.js";
import type { TenantDb, TenantSql } from "../src/db/tenant.js";
import { connectTenantDb } from "../src/db/tenant.js";
import type { BonfireError, Result } from "../src/result.js";
import { devEmbedder } from "../src/search/dev-embedder.js";
import { indexResourceTx } from "../src/search/index-doc.js";
import type {
  EmbeddingProvider,
  RerankProvider,
  SearchConfig,
  SearchHit,
  SearchResponse
} from "../src/search/schemas.js";
import { searchClinical } from "../src/search/search-clinical.js";

const SYNTH_SYSTEM = "http://example.org/synthetic";
const EXACT_TOKEN = "zzexactonly";
const CODE_COLLIDING_TOKEN = "syntok1832";
const PARA_TOKENS = "syntok0 syntok1 syntok2 syntok3 syntok4 syntok5";
const VEC_QUERY = "syntok682 syntok431 syntok954 syntok235 syntok275";
const DECOY_TOKENS = "alpha bravo charlie delta echo foxtrot";

const db: TenantDb = connectTenantDb({ max: 6 });
afterAll(() => db.end());

interface Doc {
  readonly id: string;
  readonly content: JsonObject;
}

function observation(body: JsonObject): Doc {
  const id = randomUUID();
  return { id, content: { resourceType: "Observation", id, status: "final", ...body } };
}

function fusionCorpus(): { docLex: Doc; docCode: Doc; docPara: Doc; decoy: Doc; all: Doc[] } {
  const docLex = observation({ code: { coding: [{ system: SYNTH_SYSTEM, code: EXACT_TOKEN }] } });
  const docCode = observation({
    code: { coding: [{ system: SYNTH_SYSTEM, code: CODE_COLLIDING_TOKEN }] }
  });
  const docPara = observation({ code: { text: "vitalsign" }, note: [{ text: PARA_TOKENS }] });
  const decoy = observation({ code: { text: "decoyneutral" }, note: [{ text: DECOY_TOKENS }] });
  return { docLex, docCode, docPara, decoy, all: [docLex, docCode, docPara, decoy] };
}

/** Attempts for a hermetic seed — retries a transient tx failure under load. */
const SEED_ATTEMPTS = 3;

async function seed(
  practiceId: string,
  docs: readonly Doc[],
  embedder?: EmbeddingProvider
): Promise<void> {
  // Bounded retry: under concurrent `turbo run test` DB load a per-request tx can
  // fail transiently (TENANT_TX_FAILED). withTenant is atomic — a failed tx commits
  // nothing and the ids are random — so re-running the seed is safe, not a double
  // insert. Any other error (or exhausting the retries) is a hard failure.
  for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt += 1) {
    const result = await db.withTenant(practiceId, async (sql) => {
      for (const doc of docs) {
        const inserted = await insertFhirResourceTx(sql, {
          id: doc.id,
          type: "Observation",
          content: doc.content,
          rawPayload: JSON.stringify(doc.content)
        });
        if (!inserted.ok) throw new Error(inserted.error.message);
        const indexed = await indexResourceTx(sql, doc.id, embedder);
        if (!indexed.ok) throw new Error(indexed.error.message);
      }
      return true;
    });
    if (result.ok) return;
    if (result.error.code !== "TENANT_TX_FAILED" || attempt === SEED_ATTEMPTS - 1) {
      throw new Error(`seed failed: ${result.error.code}`);
    }
  }
}

function clinicianInput(query: string, practiceId: string): unknown {
  return {
    query,
    subject: { id: "clinician-1", role: "clinician", practiceId },
    purposeOfUse: "TREAT"
  };
}

async function search(
  practiceId: string,
  query: string,
  reranker?: RerankProvider
): Promise<SearchResponse> {
  const config = reranker === undefined ? {} : { reranker };
  const outer = await db.withTenant(practiceId, (sql) =>
    searchClinical(sql, clinicianInput(query, practiceId), config)
  );
  if (!outer.ok) throw new Error(`tenant tx failed: ${outer.error.code}`);
  if (!outer.data.ok) throw new Error(`search error: ${outer.data.error.code}`);
  return outer.data.data;
}

function ids(response: SearchResponse): string[] {
  return response.results.map((hit) => hit.resourceId);
}

const FIXED_CLOCK: () => string = () => "2026-07-07T00:00:00.000Z";

/** Unwrap withTenant + searchClinical to the inner Result (for deny/err paths). */
async function runResult(
  practiceId: string,
  input: unknown,
  config: SearchConfig = {}
): Promise<Result<SearchResponse, BonfireError>> {
  const outer = await db.withTenant(practiceId, (sql) => searchClinical(sql, input, config));
  if (!outer.ok) throw new Error(`tenant tx failed: ${outer.error.code}`);
  return outer.data;
}

async function runOk(
  practiceId: string,
  input: unknown,
  config: SearchConfig = {}
): Promise<SearchResponse> {
  const inner = await runResult(practiceId, input, config);
  if (!inner.ok) throw new Error(`search error: ${inner.error.code}`);
  return inner.data;
}

/** Proxy the tenant sql handle, recording every tagged-template query text. */
function spySql(real: TenantSql): { readonly sql: TenantSql; readonly queries: string[] } {
  const queries: string[] = [];
  const sql = new Proxy(real, {
    apply(target, thisArg, args): unknown {
      const first: unknown = args[0];
      if (Array.isArray(first)) queries.push(first.join(" ? "));
      return Reflect.apply(target, thisArg, args);
    }
  });
  return { sql, queries };
}

/** Run a search through a query spy; returns the response and captured SQL. */
async function searchSpied(
  practiceId: string,
  input: unknown
): Promise<{ readonly response: SearchResponse; readonly queries: string[] }> {
  let queries: string[] = [];
  const outer = await db.withTenant(practiceId, async (sql) => {
    const spy = spySql(sql);
    const result = await searchClinical(spy.sql, input, {});
    queries = spy.queries;
    return result;
  });
  if (!outer.ok) throw new Error(`tenant tx failed: ${outer.error.code}`);
  if (!outer.data.ok) throw new Error(`search error: ${outer.data.error.code}`);
  return { response: outer.data.data, queries };
}

async function auditCount(practiceId: string): Promise<number> {
  const result = await db.withTenant(practiceId, async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from audit_log`;
    return rows[0]?.n ?? -1;
  });
  if (!result.ok) throw new Error(`audit count failed: ${result.error.code}`);
  return result.data;
}

async function latestAuditHash(practiceId: string): Promise<string | undefined> {
  const result = await db.withTenant(practiceId, async (sql) => {
    const rows = await sql<
      { row_hash: string }[]
    >`select row_hash from audit_log order by audit_log.seq desc limit 1`;
    return rows[0]?.row_hash;
  });
  if (!result.ok) throw new Error(`audit read failed: ${result.error.code}`);
  return result.data;
}

describe("BF-06 hybrid fusion — both arms contribute and fuse", () => {
  test("lexical-strong: an exact code/token surfaces the code-only doc top-ranked", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const response = await search(practice, EXACT_TOKEN);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]?.resourceId).toBe(corpus.docLex.id);
  });

  test("vector-strong: a paraphrase sharing NO lexeme surfaces the paraphrase doc top", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const response = await search(practice, VEC_QUERY);
    // No seeded doc shares a lexeme with VEC_QUERY, so a top rank can only come
    // from the semantic arm — proving the vector arm is load-bearing.
    expect(response.results[0]?.resourceId).toBe(corpus.docPara.id);
    const paraScore = response.results[0]?.score ?? 0;
    const others = response.results.slice(1).map((h) => h.score);
    for (const s of others) expect(paraScore).toBeGreaterThan(s);
  });

  test("both-match: a query hitting one doc lexically ranks it above a vector-only hit", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const response = await search(practice, CODE_COLLIDING_TOKEN);
    const surfaced = ids(response);
    // docCode is hit by BOTH arms (exact lexeme + self-cosine); docPara only by
    // the vector arm (collision). Fusion must rank docCode above docPara.
    expect(response.results[0]?.resourceId).toBe(corpus.docCode.id);
    expect(surfaced).toContain(corpus.docPara.id);
    const codeScore = response.results.find((h) => h.resourceId === corpus.docCode.id)?.score ?? 0;
    const paraScore = response.results.find((h) => h.resourceId === corpus.docPara.id)?.score ?? 0;
    expect(codeScore).toBeGreaterThan(paraScore);
  });

  test("determinism: the same query twice yields a byte-identical retrieval order", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const first = await search(practice, CODE_COLLIDING_TOKEN);
    const second = await search(practice, CODE_COLLIDING_TOKEN);
    const strip = (r: SearchResponse): string =>
      JSON.stringify(
        r.results.map((h) => ({ id: h.resourceId, score: h.score, type: h.resourceType }))
      );
    expect(strip(first)).toBe(strip(second));
  });

  test("a non-default embedder is honoured end-to-end (model_id is threaded, not hardcoded)", async () => {
    // Index + search under a provider whose modelId != dev-hash-v1. If fuse.ts
    // pinned the constant model (the pre-fix foot-gun), the final join would filter
    // out every custom-model row -> zero results; threading the active model_id
    // surfaces it. Real (non-degenerate) vectors via the dev embedder's hasher.
    const practice = randomUUID();
    const doc = observation({ code: { coding: [{ system: SYNTH_SYSTEM, code: EXACT_TOKEN }] } });
    const custom: EmbeddingProvider = {
      modelId: "custom-model-v1",
      dimension: 384,
      embed: (text) => devEmbedder.embed(text)
    };
    await seed(practice, [doc], custom);
    const response = await runOk(practice, clinicianInput(EXACT_TOKEN, practice), {
      embedder: custom
    });
    expect(ids(response)).toContain(doc.id);
  });
});

describe("BF-06 reranker OFF by default (no PHI egress in the default path)", () => {
  test("default config performs zero reranking (RRF order preserved)", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const rrf = await search(practice, CODE_COLLIDING_TOKEN);
    expect(rrf.results.length).toBeGreaterThan(1);
    const reverse: RerankProvider = {
      rerank: (hits: readonly SearchHit[]): Promise<readonly SearchHit[]> =>
        Promise.resolve([...hits].reverse())
    };
    const reranked = await search(practice, CODE_COLLIDING_TOKEN, reverse);
    // reranked === reverse(default) holds ONLY if the default path did NOT rerank
    // (otherwise the two would be equal, not reversed) — so this proves off-by-default.
    expect(reranked.results.map((h) => h.resourceId)).toEqual([...ids(rrf)].reverse());
  });

  test("the default search makes zero external fetch calls (no PHI egress)", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (): never => {
      fetchCalls += 1;
      throw new Error("no network egress permitted from search");
    };
    try {
      const response = await search(practice, EXACT_TOKEN);
      expect(response.results.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);
    expect(devEmbedder.modelId).toBe("dev-hash-v1");
  });
});

describe("BF-06 scope-before-retrieve + default-deny (fail-closed)", () => {
  test("a denied search runs ZERO fusion SQL (scope applied before retrieval)", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const billerInput = {
      query: EXACT_TOKEN,
      subject: { id: "biller-1", role: "biller", practiceId: practice },
      purposeOfUse: "HPAYMT"
    };
    const denied = await searchSpied(practice, billerInput);
    expect(denied.response.results.length).toBe(0);
    expect(denied.queries.some((q) => q.includes("search_doc"))).toBe(false);
    // Contrast: an allowed search DOES touch search_doc — proving the guard is load-bearing.
    const allowed = await searchSpied(practice, clinicianInput(EXACT_TOKEN, practice));
    expect(allowed.queries.some((q) => q.includes("search_doc"))).toBe(true);
  });

  test("default-deny: a non-clinician / bad-purpose lands every type in excludedByPolicy", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const response = await runOk(practice, {
      query: EXACT_TOKEN,
      subject: { id: "biller-1", role: "biller", practiceId: practice },
      purposeOfUse: "HPAYMT"
    });
    expect(response.results.length).toBe(0);
    expect(response.policyReceipt.decision).toBe("deny");
    expect(response.excludedByPolicy.count).toBe(8);
    expect(response.excludedByPolicy.resourceTypes).toContainEqual({
      resourceType: "Observation",
      reason: "deny: no matching allow rule",
      matchedRuleId: null
    });
  });

  test("default-deny: a cross-practice subject (subject.practiceId != tenant) denies", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    // Subject claims a DIFFERENT practice than the bound tenant → decide() denies.
    const response = await runOk(practice, {
      query: EXACT_TOKEN,
      subject: { id: "clinician-x", role: "clinician", practiceId: randomUUID() },
      purposeOfUse: "TREAT"
    });
    expect(response.results.length).toBe(0);
    expect(response.excludedByPolicy.count).toBe(8);
  });

  test("malformed input is a typed err (no throw across the boundary)", async () => {
    const practice = randomUUID();
    const result = await runResult(practice, { query: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEARCH_INVALID_INPUT");
  });
});

describe("BF-06 cross-tenant isolation (RLS fail-closed)", () => {
  test("an identical term under two practices: A sees zero of B's rows", async () => {
    const practiceA = randomUUID();
    const practiceB = randomUUID();
    const corpusA = fusionCorpus();
    const corpusB = fusionCorpus();
    await seed(practiceA, corpusA.all);
    await seed(practiceB, corpusB.all);
    const bIds = new Set(corpusB.all.map((d) => d.id));
    const aIds = new Set(corpusA.all.map((d) => d.id));
    const asA = await runOk(practiceA, clinicianInput(EXACT_TOKEN, practiceA));
    expect(asA.results.length).toBeGreaterThan(0);
    for (const hit of asA.results) {
      expect(bIds.has(hit.resourceId)).toBe(false);
      expect(aIds.has(hit.resourceId)).toBe(true);
    }
  });
});

describe("BF-06 audit-on-read (every path writes exactly one audit row)", () => {
  test("a normal search: +1 audit row; auditEventId == stored row_hash == each citation.rowHash", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const before = await auditCount(practice);
    const response = await runOk(practice, clinicianInput(EXACT_TOKEN, practice));
    const after = await auditCount(practice);
    expect(after - before).toBe(1);
    expect(await latestAuditHash(practice)).toBe(response.auditEventId);
    expect(response.results.length).toBeGreaterThan(0);
    for (const hit of response.results) expect(hit.citation.rowHash).toBe(response.auditEventId);
  });

  test("a zero-result search still writes exactly one audit row", async () => {
    const practice = randomUUID();
    const before = await auditCount(practice);
    const response = await runOk(practice, clinicianInput(EXACT_TOKEN, practice));
    const after = await auditCount(practice);
    expect(response.results.length).toBe(0);
    expect(after - before).toBe(1);
    expect(response.policyReceipt.decision).toBe("allow");
    expect(await latestAuditHash(practice)).toBe(response.auditEventId);
  });

  test("a denied search still writes exactly one audit row (deny)", async () => {
    const practice = randomUUID();
    const before = await auditCount(practice);
    const response = await runOk(practice, {
      query: EXACT_TOKEN,
      subject: { id: "biller-1", role: "biller", practiceId: practice },
      purposeOfUse: "HPAYMT"
    });
    const after = await auditCount(practice);
    expect(after - before).toBe(1);
    expect(response.policyReceipt.decision).toBe("deny");
    expect(await latestAuditHash(practice)).toBe(response.auditEventId);
  });
});

describe("BF-06 golden shape (deterministic, fixed clock)", () => {
  test("citation/freshness/excludedByPolicy/policyReceipt shape + rowHash==auditEventId", async () => {
    const practice = randomUUID();
    const corpus = fusionCorpus();
    await seed(practice, corpus.all);
    const response = await runOk(practice, clinicianInput(EXACT_TOKEN, practice), {
      now: FIXED_CLOCK
    });
    const hit = response.results[0];
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    expect(Object.keys(hit).sort()).toEqual([
      "citation",
      "freshness",
      "resourceId",
      "resourceType",
      "score"
    ]);
    expect(Object.keys(hit.citation).sort()).toEqual(["path", "resourceId", "rowHash"]);
    expect(hit.citation.resourceId).toBe(hit.resourceId);
    expect(hit.citation.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.citation.rowHash).toBe(response.auditEventId);
    expect(Object.keys(hit.freshness).sort()).toEqual(["lastUpdated", "versionId"]);
    expect(hit.freshness.versionId).toBe("1");
    expect(response.excludedByPolicy).toEqual({ count: 0, resourceTypes: [] });
    expect(response.policyReceipt).toEqual({
      decision: "allow",
      actorId: "clinician-1",
      resourceType: "Search",
      practiceId: practice,
      purposeOfUse: "TREAT",
      matchedRuleId: null,
      reason: "search: 8 type(s) in scope",
      timestamp: "2026-07-07T00:00:00.000Z"
    });
    expect(response.auditEventId).toMatch(/^[0-9a-f]{64}$/);
  });
});
