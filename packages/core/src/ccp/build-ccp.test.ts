/**
 * BF-07 DB battery (dangerChecks: scope-after-retrieve, cross-tenant-leak,
 * audit-bypass). Hermetic (BP-024): every test mints a fresh random practice,
 * seeds a synthetic multi-type corpus through the canonical write path + the
 * exported indexer, runs the REAL searchClinical, and builds the CCP in the
 * SAME withTenant transaction. A tagged-template tap on the tenant handle
 * counts every fhir_resources / search_doc statement buildCcp issues, so the
 * single-read and refuse-before-read guarantees are asserted on execution, not
 * on prose. All data is synthetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditRowHash } from "../audit/row-hash.js";
import type { JsonObject, JsonValue } from "../db/canonical-json.js";
import { canonicalizeJson } from "../db/canonical-json.js";
import { insertFhirResourceTx, jsonValueSchema, updateFhirResourceTx } from "../db/fhir-store.js";
import type { TenantDb, TenantSql } from "../db/tenant.js";
import { connectTenantDb } from "../db/tenant.js";
import type { Result } from "../result.js";
import { indexResourceTx } from "../search/index-doc.js";
import type { SearchResponse } from "../search/schemas.js";
import { searchClinical } from "../search/search-clinical.js";
import { buildCcp } from "./build-ccp.js";
import { ccpContentDigest } from "./content-digest.js";
import type { CcpError } from "./errors.js";
import type { CcpDocument } from "./schemas.js";
import { measureCcp } from "./token-count.js";

const QUERY = "ccptok";
const SYNTH = "http://example.org/synthetic";
const CORPUS_SIZE = 5;

const db: TenantDb = connectTenantDb({ max: 4 });
afterAll(() => db.end());

interface SeedDoc {
  readonly id: string;
  readonly type: string;
  readonly content: JsonObject;
}

function synthDoc(type: string, body: JsonObject): SeedDoc {
  const id = randomUUID();
  return { id, type, content: { resourceType: type, id, ...body } };
}

/** Five searchable synthetic resources, one per exercised leaf table. */
function goldenCorpus(): SeedDoc[] {
  return [
    synthDoc("Patient", {
      name: [{ family: "Ccptok", given: ["Synthia"] }],
      birthDate: "1980-02-03"
    }),
    synthDoc("Condition", {
      code: {
        coding: [{ system: SYNTH, code: "ccptok-i10", display: "Ccptok hypertension" }],
        text: "ccptok condition"
      },
      clinicalStatus: { coding: [{ code: "active" }] },
      onsetDateTime: "2024-01-15",
      note: [{ text: "stable on ccptok therapy" }]
    }),
    synthDoc("Observation", {
      code: { coding: [{ system: SYNTH, code: "ccptok-bp", display: "Ccptok systolic pressure" }] },
      valueQuantity: { value: 7.25, unit: "mmol/L" },
      effectiveDateTime: "2026-06-30T08:45:00Z",
      note: [{ text: "ccptok level trending down" }]
    }),
    synthDoc("MedicationRequest", {
      medicationCodeableConcept: {
        coding: [{ system: SYNTH, code: "ccptok-rx", display: "Ccptok lisinopril 10 MG" }]
      },
      status: "active",
      authoredOn: "2025-11-14"
    }),
    synthDoc("DocumentReference", {
      type: {
        coding: [{ system: SYNTH, code: "ccptok-doc", display: "Ccptok discharge summary" }]
      },
      content: [{ attachment: { title: "ccptok visit note" } }],
      date: "2026-05-19",
      status: "current"
    })
  ];
}

const SEED_TRIES = 3;

async function seedCorpus(practice: string, docs: readonly SeedDoc[]): Promise<void> {
  let failure = "";
  for (let attempt = 0; attempt < SEED_TRIES; attempt += 1) {
    const outcome = await db.withTenant(practice, async (sql) => {
      for (const doc of docs) {
        const written = await insertFhirResourceTx(sql, {
          id: doc.id,
          type: doc.type,
          content: doc.content,
          rawPayload: JSON.stringify(doc.content)
        });
        if (!written.ok) throw new Error(written.error.code);
        const indexed = await indexResourceTx(sql, doc.id);
        if (!indexed.ok) throw new Error(indexed.error.code);
      }
    });
    if (outcome.ok) return;
    failure = outcome.error.code;
    // withTenant is atomic and the ids are random, so retrying a transient tx
    // failure under concurrent gate load can never double-seed.
    if (failure !== "TENANT_TX_FAILED") break;
  }
  throw new Error(`ccp corpus seed failed: ${failure}`);
}

function subjectFor(practice: string): { id: string; role: "clinician"; practiceId: string } {
  return { id: "clin-ccp-1", role: "clinician", practiceId: practice };
}

async function withPractice<T>(practice: string, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const outer = await db.withTenant(practice, fn);
  if (!outer.ok) throw new Error(`tenant tx failed: ${outer.error.code}`);
  return outer.data;
}

async function searchTreat(sql: TenantSql, practice: string): Promise<SearchResponse> {
  const found = await searchClinical(
    sql,
    { query: QUERY, subject: subjectFor(practice), purposeOfUse: "TREAT" },
    {}
  );
  if (!found.ok) throw new Error(`search failed: ${found.error.code}`);
  return found.data;
}

function inputFor(response: SearchResponse, practice: string): unknown {
  return { response, subject: subjectFor(practice), purposeOfUse: "TREAT" };
}

async function auditRows(sql: TenantSql): Promise<number> {
  const rows = await sql`select count(*)::int as n from audit_log`;
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

interface TrackedBuild {
  readonly outcome: Result<CcpDocument, CcpError>;
  readonly fhirReads: number;
  readonly searchDocReads: number;
  readonly auditDelta: number;
}

/** Build through a tagged-template tap that records every statement text. */
async function trackedBuild(sql: TenantSql, input: unknown): Promise<TrackedBuild> {
  const before = await auditRows(sql);
  const statements: string[] = [];
  const tap = new Proxy(sql, {
    apply(target, thisArg, args): unknown {
      const head: unknown = args[0];
      if (Array.isArray(head)) statements.push(head.join(" @ "));
      return Reflect.apply(target, thisArg, args);
    }
  });
  const outcome = await buildCcp(tap, input);
  const after = await auditRows(sql);
  return {
    outcome,
    fhirReads: statements.filter((s) => s.includes("fhir_resources")).length,
    searchDocReads: statements.filter((s) => s.includes("search_doc")).length,
    auditDelta: after - before
  };
}

const auditTipSchema = z.object({
  row_hash: z.string(),
  prev_hash: z.string(),
  reason: z.string(),
  matched_rule_id: z.string().nullable(),
  purpose_of_use: z.string(),
  resource_type: z.string(),
  decision: z.string(),
  actor_id: z.string(),
  occurred_at: z.string(),
  practice_id: z.string(),
  seq: z.string()
});

async function latestAuditRow(sql: TenantSql): Promise<z.infer<typeof auditTipSchema>> {
  const rows = await sql`
    select actor_id, decision, resource_type, purpose_of_use, matched_rule_id, reason,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
      practice_id::text as practice_id, seq::text as seq, prev_hash, row_hash
    from audit_log order by audit_log.seq desc limit 1`;
  return auditTipSchema.parse(rows[0]);
}

/** Re-resolve one cited (resourceId, jsonPath) pair from canonical FHIR. */
async function resolveLeaf(sql: TenantSql, resourceId: string, path: string): Promise<JsonValue> {
  const rows = await sql`
    select content #> string_to_array(${path}, '.') as leaf
    from fhir_resources where id = ${resourceId}`;
  return z.object({ leaf: jsonValueSchema }).parse(rows[0]).leaf;
}

function unwrapOk(outcome: Result<CcpDocument, CcpError>): CcpDocument {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`);
  return outcome.data;
}

function unwrapErr(outcome: Result<CcpDocument, CcpError>): CcpError {
  if (outcome.ok) throw new Error("expected err, got an ok document");
  return outcome.error;
}

describe("BF-07 result boundary + single-read spine", () => {
  test("malformed input is a typed err with NO audit row and NO reads", async () => {
    const practice = randomUUID();
    const run = await withPractice(practice, (sql) =>
      trackedBuild(sql, { response: {}, purposeOfUse: "nope" })
    );
    expect(unwrapErr(run.outcome).code).toBe("MALFORMED_INPUT");
    expect(run.auditDelta).toBe(0);
    expect(run.fhirReads).toBe(0);
  });

  test("a valid composed build returns a schema-shaped ok document via ONE canonical read", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const run = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const tracked = await trackedBuild(sql, inputFor(response, practice));
      return { response, ...tracked };
    });
    const doc = unwrapOk(run.outcome);
    expect(run.response.results).toHaveLength(CORPUS_SIZE);
    expect(doc.version).toBe("ccp/v1");
    expect(doc.practiceId).toBe(practice);
    expect(doc.excludedByPolicy).toEqual({ count: 0, resourceTypes: [] });
    expect(doc.spans).toHaveLength(21);
    for (const span of doc.spans) {
      expect(span.resourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(span.jsonPath.length).toBeGreaterThan(0);
      expect(span.auditHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(run.fhirReads).toBe(1); // the single id-set read (Class 2)
    expect(run.searchDocReads).toBe(0); // no retrieval outside the scoped set
    expect(run.auditDelta).toBe(1); // exactly one audit append
  });

  test("a zero-hit search still yields an audited ok document with zero spans", async () => {
    const practice = randomUUID();
    const run = await withPractice(practice, async (sql) => {
      const found = await searchClinical(
        sql,
        { query: QUERY, subject: subjectFor(practice), purposeOfUse: "TREAT" },
        {}
      );
      if (!found.ok) throw new Error(found.error.code);
      return trackedBuild(sql, inputFor(found.data, practice));
    });
    const doc = unwrapOk(run.outcome);
    expect(doc.spans).toEqual([]);
    expect(doc.text.split("\n")).toHaveLength(2);
    expect(run.auditDelta).toBe(1); // audit-bypass: the empty read is still audited
    expect(run.fhirReads).toBe(0); // an empty id set skips even the id-set read
  });

  test("a duplicated hit id projects a single group (no double spans)", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const doc = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const dup = response.results[0];
      if (dup === undefined) throw new Error("expected hits");
      const built = await buildCcp(
        sql,
        inputFor({ ...response, results: [...response.results, dup] }, practice)
      );
      return unwrapOk(built);
    });
    expect(doc.text.split("\n").filter((line) => line.startsWith("["))).toHaveLength(CORPUS_SIZE);
  });
});

describe("BF-07 citation precision (acceptance #3)", () => {
  test("every span re-resolves from the canonical row to an equal value (precision 1.0)", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const { doc, mismatches } = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const document = unwrapOk(await buildCcp(sql, inputFor(response, practice)));
      const wrong: string[] = [];
      for (const span of document.spans) {
        const leaf = await resolveLeaf(sql, span.resourceId, span.jsonPath);
        if (canonicalizeJson(leaf) !== canonicalizeJson(span.value)) {
          wrong.push(`${span.resourceId}:${span.jsonPath}`);
        }
      }
      return { doc: document, mismatches: wrong };
    });
    expect(doc.spans.length).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
    // both scalar kinds are exercised — the numeric leaf (7.25) and strings
    const kinds = new Set(doc.spans.map((span) => typeof span.value));
    expect(kinds.has("number")).toBe(true);
    expect(kinds.has("string")).toBe(true);
  });
});

describe("BF-07 audit binding (acceptance #4)", () => {
  test("span auditHash == document auditEventId == chain tip; row-hash and digest recompute", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const { doc, response, tip } = await withPractice(practice, async (sql) => {
      const searched = await searchTreat(sql, practice);
      const document = unwrapOk(await buildCcp(sql, inputFor(searched, practice)));
      return { doc: document, response: searched, tip: await latestAuditRow(sql) };
    });
    expect(tip.resource_type).toBe("CcpProjection");
    expect(tip.decision).toBe("allow");
    expect(tip.actor_id).toBe("clin-ccp-1");
    expect(tip.purpose_of_use).toBe("TREAT");
    expect(doc.auditEventId).toBe(tip.row_hash);
    for (const span of doc.spans) expect(span.auditHash).toBe(tip.row_hash);
    // the persisted row re-hashes to its own row_hash (chain-verifiable)
    const recomputed = auditRowHash(
      {
        actorId: tip.actor_id,
        decision: tip.decision,
        resourceType: tip.resource_type,
        purposeOfUse: tip.purpose_of_use,
        matchedRuleId: tip.matched_rule_id,
        reason: tip.reason,
        occurredAt: tip.occurred_at,
        practiceId: tip.practice_id,
        seq: tip.seq
      },
      tip.prev_hash
    );
    expect(recomputed).toBe(tip.row_hash);
    // the reason binds provenance + the digest of the consumed artifact
    expect(tip.reason).toContain(`src=${response.auditEventId}`);
    const digest = ccpContentDigest(
      doc.spans.map(({ auditHash: _auditHash, ...draft }) => draft),
      doc.text,
      response.auditEventId
    );
    expect(tip.reason).toContain(`contentDigest=${digest}`);
  });

  test("mutating the source value or the audit row is DETECTED as a hash mismatch", async () => {
    const practice = randomUUID();
    const corpus = goldenCorpus();
    const observation = corpus.find((doc) => doc.type === "Observation");
    if (observation === undefined) throw new Error("corpus must hold an Observation");
    await seedCorpus(practice, corpus);
    await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const doc = unwrapOk(await buildCcp(sql, inputFor(response, practice)));
      const tip = await latestAuditRow(sql);
      // 1) tamper the SOURCE through the canonical write path
      const doctored: JsonObject = {
        ...observation.content,
        valueQuantity: { value: 9.99, unit: "mmol/L" }
      };
      const updated = await updateFhirResourceTx(sql, { id: observation.id, content: doctored });
      if (!updated.ok) throw new Error(updated.error.code);
      const leafNow = await resolveLeaf(sql, observation.id, "valueQuantity.value");
      const cited = doc.spans.find(
        (span) => span.resourceId === observation.id && span.jsonPath === "valueQuantity.value"
      );
      expect(cited).toBeDefined();
      // the mutation is visible against the cited span value...
      expect(canonicalizeJson(leafNow)).not.toBe(canonicalizeJson(cited!.value));
      // ...and a digest over the tampered values no longer matches the audited one
      const tamperedDrafts = doc.spans.map(({ auditHash: _auditHash, ...draft }) =>
        draft.resourceId === observation.id && draft.jsonPath === "valueQuantity.value"
          ? { ...draft, value: 9.99 }
          : draft
      );
      const tamperedDigest = ccpContentDigest(tamperedDrafts, doc.text, response.auditEventId);
      expect(tip.reason).toContain("contentDigest=");
      expect(tip.reason).not.toContain(`contentDigest=${tamperedDigest}`);
      // 2) tamper the AUDIT ROW: a doctored reason no longer re-hashes to row_hash
      const forged = auditRowHash(
        {
          actorId: tip.actor_id,
          decision: tip.decision,
          resourceType: tip.resource_type,
          purposeOfUse: tip.purpose_of_use,
          matchedRuleId: tip.matched_rule_id,
          reason: `${tip.reason} (doctored)`,
          occurredAt: tip.occurred_at,
          practiceId: tip.practice_id,
          seq: tip.seq
        },
        tip.prev_hash
      );
      expect(forged).not.toBe(tip.row_hash);
    });
  });
});

describe("BF-07 U-shape emission (acceptance #5)", () => {
  test("groups follow the documented U-shape of the response rank order, deterministically", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const run = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const first = unwrapOk(await buildCcp(sql, inputFor(response, practice)));
      const second = unwrapOk(await buildCcp(sql, inputFor(response, practice)));
      return { response, first, second };
    });
    const rankIds = run.response.results.map((hit) => hit.resourceId);
    const groupIds = run.first.text
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => line.split("/")[1]?.split(" ")[0]);
    // rank1 first, rank2 LAST, rank3 second, rank4 second-to-last, rank5 middle
    expect(groupIds).toEqual([rankIds[0], rankIds[2], rankIds[4], rankIds[3], rankIds[1]]);
    // the document's span order follows the same emitted group order
    expect([...new Set(run.first.spans.map((span) => span.resourceId))]).toEqual(groupIds);
    // pure function of the response: byte-identical text on a rebuild
    expect(run.second.text).toBe(run.first.text);
  });
});

describe("BF-07 scope guards (acceptance #8 — no leak, no scope-after-retrieve)", () => {
  test("a forged foreign id NEVER materializes a span: UNRESOLVED_RESULT, count-only, audited", async () => {
    const practiceA = randomUUID();
    const practiceB = randomUUID();
    const foreign = synthDoc("Condition", {
      code: {
        coding: [{ system: SYNTH, code: "ccptok-b1", display: "Ccptok foreign condition" }],
        text: "ccptok foreign"
      },
      onsetDateTime: "2022-02-02"
    });
    await seedCorpus(practiceB, [foreign]);
    await seedCorpus(practiceA, goldenCorpus());
    const run = await withPractice(practiceA, async (sql) => {
      const response = await searchTreat(sql, practiceA);
      const forgedResults = [
        ...response.results,
        {
          resourceType: foreign.type,
          resourceId: foreign.id,
          score: 0.001,
          citation: { resourceId: foreign.id, path: "code", rowHash: response.auditEventId },
          freshness: { lastUpdated: "2026-07-01 00:00:00+00", versionId: "1" }
        }
      ];
      return trackedBuild(sql, inputFor({ ...response, results: forgedResults }, practiceA));
    });
    const error = unwrapErr(run.outcome);
    expect(error.code).toBe("UNRESOLVED_RESULT");
    expect(error.count).toBe(1);
    // no existence oracle, no span: the foreign id appears NOWHERE in the result
    expect(JSON.stringify(run.outcome)).not.toContain(foreign.id);
    expect(run.auditDelta).toBe(1); // the denial is audited
    expect(run.fhirReads).toBe(1); // the single read ran; RLS filtered the row
  });

  test("a relabeled same-tenant hit is refused: TYPE_MISMATCH (Class 1b)", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const run = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const results = response.results.map((hit) =>
        hit.resourceType === "DocumentReference" ? { ...hit, resourceType: "Observation" } : hit
      );
      return trackedBuild(sql, inputFor({ ...response, results }, practice));
    });
    const error = unwrapErr(run.outcome);
    expect(error.code).toBe("TYPE_MISMATCH");
    expect(error.count).toBe(1);
    expect(run.auditDelta).toBe(1);
  });

  test("a role swap after retrieval is refused: SCOPE_EXCLUDED_TYPE (latent fail-open closed)", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const run = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      // same actor id, purpose, and tenant — the receipt cross-check passes —
      // but the BUILDING subject's role is biller, which decide() denies.
      const biller = { id: "clin-ccp-1", role: "biller", practiceId: practice };
      return trackedBuild(sql, { response, subject: biller, purposeOfUse: "TREAT" });
    });
    const error = unwrapErr(run.outcome);
    expect(error.code).toBe("SCOPE_EXCLUDED_TYPE");
    expect(error.count).toBe(CORPUS_SIZE); // every resolved row is outside the scope
    expect(run.auditDelta).toBe(1);
  });

  test("purpose laundering, a deny receipt, or an actor swap refuse BEFORE any read", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const runs = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      const laundered = await trackedBuild(sql, {
        response,
        subject: subjectFor(practice),
        purposeOfUse: "HRESCH"
      });
      const actorSwap = await trackedBuild(sql, {
        response,
        subject: { ...subjectFor(practice), id: "someone-else" },
        purposeOfUse: "TREAT"
      });
      const biller = { id: "biller-1", role: "biller", practiceId: practice };
      const denied = await searchClinical(
        sql,
        { query: QUERY, subject: biller, purposeOfUse: "HPAYMT" },
        {}
      );
      if (!denied.ok) throw new Error(denied.error.code);
      const denyBuild = await trackedBuild(sql, {
        response: denied.data,
        subject: biller,
        purposeOfUse: "HPAYMT"
      });
      return [laundered, actorSwap, denyBuild];
    });
    for (const run of runs) {
      expect(unwrapErr(run.outcome).code).toBe("RECEIPT_MISMATCH");
      expect(run.fhirReads).toBe(0); // refused before the canonical read
      expect(run.auditDelta).toBe(1); // the refusal is audited
    }
  });

  test("practice B's response replayed under practice A dies pre-read (RECEIPT_MISMATCH)", async () => {
    const practiceA = randomUUID();
    const practiceB = randomUUID();
    await seedCorpus(practiceB, goldenCorpus());
    const bResponse = await withPractice(practiceB, (sql) => searchTreat(sql, practiceB));
    const run = await withPractice(practiceA, (sql) =>
      trackedBuild(sql, {
        response: bResponse,
        subject: subjectFor(practiceA),
        purposeOfUse: "TREAT"
      })
    );
    expect(unwrapErr(run.outcome).code).toBe("RECEIPT_MISMATCH");
    expect(run.fhirReads).toBe(0); // zero canonical reads under the wrong tenant
    expect(run.auditDelta).toBe(1);
    const firstForeignId = bResponse.results[0]?.resourceId ?? "missing";
    expect(JSON.stringify(run.outcome)).not.toContain(firstForeignId);
  });
});

describe("BF-07 non-scalar stored leaf (panel finding B — boundary + audit hold)", () => {
  test("a cited non-scalar declared leaf skips its span, returns ok, audits once (no throw)", async () => {
    const practice = randomUUID();
    // fhirContentSchema accepts arbitrary JSON, so a same-tenant writer can store a
    // subtree where a scalar leaf is declared. buildCcp must SKIP the span, not throw
    // past the Result boundary (acceptance #1) or skip the audit append (T8).
    const poisoned = synthDoc("Observation", {
      code: { coding: [{ system: SYNTH, code: "ccptok-bad", display: "Ccptok poisoned obs" }] },
      valueQuantity: { value: 9.5, unit: "mmol/L" },
      valueString: { nested: "not-a-scalar" },
      note: [{ text: "ccptok poisoned" }]
    });
    await seedCorpus(practice, [poisoned]);
    const run = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      return trackedBuild(sql, inputFor(response, practice));
    });
    const doc = unwrapOk(run.outcome); // it returned a Result — it did NOT throw
    expect(run.auditDelta).toBe(1); // T8: exactly one audit row despite the skipped leaf
    // the non-scalar leaf never materializes and its subtree never leaks into the doc
    expect(doc.spans.some((span) => span.jsonPath === "valueString")).toBe(false);
    expect(doc.text).not.toContain("not-a-scalar");
    expect(JSON.stringify(doc.spans)).not.toContain("not-a-scalar");
    // the well-formed sibling leaves on the same resource still project
    expect(doc.spans.some((span) => span.jsonPath === "valueQuantity.value")).toBe(true);
  });
});

describe("BF-07 token residual on the live build (acceptance #7)", () => {
  test("the built document measures >= 1.4x smaller than compact JSON of its spans", async () => {
    const practice = randomUUID();
    await seedCorpus(practice, goldenCorpus());
    const doc = await withPractice(practice, async (sql) => {
      const response = await searchTreat(sql, practice);
      return unwrapOk(await buildCcp(sql, inputFor(response, practice)));
    });
    const measured = measureCcp(doc);
    expect(measured.tokenizerId).toBe("gpt-tokenizer/o200k_base");
    expect(measured.ccpTokens).toBeGreaterThan(0);
    expect(measured.ratio).toBeGreaterThanOrEqual(1.4);
  });
});
