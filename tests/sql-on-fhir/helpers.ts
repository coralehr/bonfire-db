/**
 * Shared scaffolding for the BF-04 DB-backed integration tests. Hermetic by
 * construction (BP-024): every test run mints fresh practice UUIDs and fresh
 * resource UUIDs, inserts its own synthetic corpus through the real tenant
 * write path, and never truncates shared tables outside the sanctioned
 * rebuild path. ALL data below is synthetic-only.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import postgres from "postgres";
import type { JsonObject, TenantDb, TenantSql } from "../../packages/core/src/index.js";
import {
  connectTenantDb,
  devDatabaseUrl,
  insertFhirResourceTx
} from "../../packages/core/src/index.js";
import type {
  MaterializableView,
  RebuildSummary,
  TablePlan
} from "../../packages/sql-on-fhir/src/index.js";
import {
  loadScribeViews,
  orderedDumpHash,
  planTable,
  rebuildProjections,
  upsertProjection
} from "../../packages/sql-on-fhir/src/index.js";

const silentNotice = { onnotice: () => undefined };

/** Owner (migration-role) connection — DDL, rebuilds, cross-tenant oracles. */
export function ownerSql(): Sql {
  const url = process.env.MIGRATE_DATABASE_URL ?? devDatabaseUrl("migrate");
  return postgres(url, { max: 1, ...silentNotice });
}

/** Raw bonfire_app connection for garbage/empty tenant-GUC probes. */
export function appSql(): Sql {
  return postgres(devDatabaseUrl("app"), { max: 1, ...silentNotice });
}

/** The RLS-subject tenant surface (the only product query path). */
export function tenantDb(): TenantDb {
  return connectTenantDb({ max: 1 });
}

/** Everything a projection test needs, opened once per file. */
export interface TestContext {
  readonly owner: Sql;
  readonly db: TenantDb;
  readonly views: MaterializableView[];
  readonly plans: TablePlan[];
}

export function initContext(): TestContext {
  const views = scribeViews();
  return { owner: ownerSql(), db: tenantDb(), views, plans: scribePlans(views) };
}

export async function closeContext(ctx: TestContext): Promise<void> {
  await ctx.owner.end({ timeout: 5 });
  await ctx.db.end();
}

function scribeViews(): MaterializableView[] {
  const views = loadScribeViews();
  if (!views.ok) throw new Error(views.error.message);
  return views.data;
}

function scribePlans(views: readonly MaterializableView[]): TablePlan[] {
  return views.map((view) => {
    const plan = planTable(view);
    if (!plan.ok) throw new Error(plan.error.message);
    return plan.data;
  });
}

export async function rebuildAll(
  owner: Sql,
  views: readonly MaterializableView[]
): Promise<RebuildSummary> {
  const summary = await rebuildProjections(owner, views);
  if (!summary.ok) throw new Error(`[${summary.error.code}] ${summary.error.message}`);
  return summary.data;
}

export interface CorpusEntry {
  readonly id: string;
  readonly type: string;
  readonly content: JsonObject;
}

export interface SyntheticCorpus {
  readonly entries: readonly CorpusEntry[];
  readonly patientId: string;
  /** Unique synthetic MRN value for this corpus (cross-tenant probe token). */
  readonly mrn: string;
}

function coded(system: string, code: string): JsonObject {
  return { coding: [{ system, code }] };
}

/** One synthetic resource per scribe type, all referencing one patient. */
export function syntheticCorpus(): SyntheticCorpus {
  const patientId = randomUUID();
  const mrn = `MRN-SYNTH-${randomUUID()}`;
  const subject = { reference: `Patient/${patientId}` };
  const entry = (type: string, body: JsonObject): CorpusEntry => {
    const id = randomUUID();
    return { id, type, content: { resourceType: type, id, ...body } };
  };
  const entries: CorpusEntry[] = [
    {
      id: patientId,
      type: "Patient",
      content: {
        resourceType: "Patient",
        id: patientId,
        gender: "female",
        birthDate: "1980-02-29",
        name: [{ family: "Zz-Testfamily", given: ["Synthea"] }],
        identifier: [{ system: "https://example.org/synthetic-mrn", value: mrn }]
      }
    },
    entry("Observation", {
      status: "final",
      code: coded("http://loinc.org", "8480-6"),
      subject,
      category: [
        coded("http://terminology.hl7.org/CodeSystem/observation-category", "vital-signs")
      ],
      effectiveDateTime: "2025-01-15T08:30:00Z",
      valueQuantity: { value: 120.5, unit: "mmHg" }
    }),
    entry("Condition", {
      clinicalStatus: coded("http://terminology.hl7.org/CodeSystem/condition-clinical", "active"),
      verificationStatus: coded(
        "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        "confirmed"
      ),
      code: coded("http://snomed.info/sct", "44054006"),
      category: [
        coded("http://terminology.hl7.org/CodeSystem/condition-category", "problem-list-item")
      ],
      subject
    }),
    entry("Encounter", {
      status: "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      type: [coded("http://snomed.info/sct", "185349003")],
      subject
    }),
    entry("Procedure", {
      status: "completed",
      code: coded("http://snomed.info/sct", "80146002"),
      subject,
      performedDateTime: "2024-11-03T10:00:00Z"
    }),
    entry("MedicationRequest", {
      status: "active",
      intent: "order",
      medicationCodeableConcept: coded("http://www.nlm.nih.gov/research/umls/rxnorm", "197361"),
      subject,
      requester: { reference: "Practitioner/synthetic-requester" },
      authoredOn: "2025-02-01T09:00:00Z"
    }),
    entry("AllergyIntolerance", {
      clinicalStatus: coded(
        "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
        "active"
      ),
      code: coded("http://snomed.info/sct", "91936005"),
      patient: subject
    }),
    entry("DocumentReference", {
      status: "current",
      type: coded("http://loinc.org", "34108-1"),
      subject,
      date: "2025-03-04T09:30:00Z",
      identifier: [{ system: "https://example.org/synthetic-doc", value: `DOC-${patientId}` }],
      content: [
        { attachment: { contentType: "text/plain", url: "https://example.org/synthetic-note.txt" } }
      ]
    })
  ];
  return { entries, patientId, mrn };
}

/** Insert one entry through the canonical write path (+ optional upsert). */
export async function insertEntryTx(
  sql: TenantSql,
  entry: CorpusEntry,
  views?: readonly MaterializableView[]
): Promise<void> {
  const inserted = await insertFhirResourceTx(sql, {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    rawPayload: JSON.stringify(entry.content)
  });
  if (!inserted.ok) throw new Error(inserted.error.message);
  if (views !== undefined) {
    const upserted = await upsertProjection(sql, entry.id, views);
    if (!upserted.ok) throw new Error(upserted.error.message);
  }
}

/** Insert a whole corpus for a practice; with `views` the projection upsert
 * runs inside the same transaction (the one-write-path shape). */
export async function insertCorpus(
  db: TenantDb,
  practiceId: string,
  entries: readonly CorpusEntry[],
  views?: readonly MaterializableView[]
): Promise<void> {
  const result = await db.withTenant(practiceId, async (sql) => {
    for (const entry of entries) {
      await insertEntryTx(sql, entry, views);
    }
    return true;
  });
  if (!result.ok) throw new Error(`corpus insert failed: ${result.error.message}`);
}

/** Two fresh practices with a full corpus each — the cross-tenant fixture. */
export interface TwoPracticeSetup {
  readonly ctx: TestContext;
  readonly practiceA: string;
  readonly practiceB: string;
  readonly corpusA: SyntheticCorpus;
  readonly corpusB: SyntheticCorpus;
}

export async function setupTwoPractices(options: {
  readonly rebuildFirst: boolean;
}): Promise<TwoPracticeSetup> {
  const ctx = initContext();
  if (options.rebuildFirst) await rebuildAll(ctx.owner, ctx.views);
  const setup: TwoPracticeSetup = {
    ctx,
    practiceA: randomUUID(),
    practiceB: randomUUID(),
    corpusA: syntheticCorpus(),
    corpusB: syntheticCorpus()
  };
  await insertCorpus(ctx.db, setup.practiceA, setup.corpusA.entries, ctx.views);
  await insertCorpus(ctx.db, setup.practiceB, setup.corpusB.entries, ctx.views);
  return setup;
}

/** Deterministic hash per projection table (spidx sans synthetic identity). */
export async function allTableHashes(
  owner: Sql,
  plans: readonly TablePlan[]
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const plan of plans) {
    const hash = await orderedDumpHash(owner, plan.table);
    if (!hash.ok) throw new Error(hash.error.message);
    hashes[plan.table] = hash.data;
  }
  const spidxHash = await orderedDumpHash(owner, "spidx", { excludeColumns: ["id"] });
  if (!spidxHash.ok) throw new Error(spidxHash.error.message);
  hashes.spidx = spidxHash.data;
  return hashes;
}
