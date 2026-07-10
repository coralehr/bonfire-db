/**
 * scripts/search-demo/run.ts — operator dev surface that drives the BF-06 product
 * search path headlessly, so the bf06 Stage-2 evals can assert against a real
 * @bonfire/core build across the harness<->product firewall (the evals cannot
 * import product code).
 *
 * cmd "seed": insertFhirResourceTx + indexResourceTx a synthetic corpus for a
 *   practice (the canonical write path + the search indexer).
 * cmd "search": run searchClinical inside the caller's withTenant tx, wrapping the
 *   tenant sql in a spy that counts reads touching `search_doc` (a DENY must run
 *   ZERO of them — scope-before-retrieve) and installing a globalThis.fetch spy
 *   that counts any off-box call (the default path must make ZERO — no PHI egress).
 * cmd "ccp": run buildCcp on a supplied CcpInput inside the caller's withTenant tx
 *   (BF-07), wrapping the tenant sql in a spy that counts reads touching
 *   `fhir_resources` (the single id-set read — must be exactly ONE on the happy
 *   path) and `search_doc` (must be ZERO — CCP reads canonical FHIR, not the
 *   index), plus the same fetch spy (ZERO off-box calls). On an ok document it
 *   also reports the offline measureCcp token ratio. The eval supplies the input
 *   (a real, or deliberately forged, SearchResponse) so scope/citation/audit
 *   guarantees are asserted against a real @bonfire/core build.
 *
 * argv[2] = a JSON job. stdout = one JSON line. Exit 0 unless the job is unreadable.
 */
import { z } from "zod";
import type { CcpDocument, SearchResponse, TenantSql } from "../../packages/core/src/index.js";
import {
  buildCcp,
  connectTenantDb,
  indexResourceTx,
  insertFhirResourceTx,
  measureCcp,
  searchClinical
} from "../../packages/core/src/index.js";

const docSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  content: z.record(z.string(), z.unknown())
});
const jobSchema = z.object({
  cmd: z.enum(["seed", "search", "ccp"]),
  practice: z.uuid(),
  corpus: z.array(docSchema).optional(),
  input: z.unknown().optional()
});
type Job = z.infer<typeof jobSchema>;

interface SearchOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly response?: SearchResponse;
  readonly searchDocQueries: number;
  readonly fetchCalls: number;
}

interface CcpOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly doc?: CcpDocument;
  readonly fhirResourceReads: number;
  readonly searchDocQueries: number;
  readonly fetchCalls: number;
  readonly tokenRatio?: number;
}

/** Wrap the tenant sql so a tagged-template read of `table` bumps the counter. */
function spyTable(real: TenantSql, table: string, onHit: () => void): TenantSql {
  return new Proxy(real, {
    apply(target, thisArg, args): unknown {
      const first: unknown = args[0];
      if (Array.isArray(first) && first.join(" ").includes(table)) onHit();
      return Reflect.apply(target, thisArg, args);
    }
  });
}

/** Chain two table spies over one tenant sql handle. */
function spyReads(real: TenantSql, onFhir: () => void, onSearchDoc: () => void): TenantSql {
  return spyTable(spyTable(real, "fhir_resources", onFhir), "search_doc", onSearchDoc);
}

/** Install a globalThis.fetch counter; returns the live count + a restore fn (no off-box call is expected). */
function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return original(...args);
  };
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

async function runSeed(practice: string, corpus: Job["corpus"]): Promise<number> {
  const docs = corpus ?? [];
  const db = connectTenantDb();
  try {
    const result = await db.withTenant(practice, async (sql) => {
      for (const doc of docs) {
        const inserted = await insertFhirResourceTx(sql, {
          id: doc.id,
          type: doc.type,
          content: doc.content,
          rawPayload: JSON.stringify(doc.content)
        });
        if (!inserted.ok) throw new Error(inserted.error.message);
        const indexed = await indexResourceTx(sql, doc.id);
        if (!indexed.ok) throw new Error(indexed.error.message);
      }
      return docs.length;
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  } finally {
    await db.end();
  }
}

async function runSearch(practice: string, input: unknown): Promise<SearchOutcome> {
  const db = connectTenantDb();
  const fetch = installFetchSpy();
  let searchDocQueries = 0;
  try {
    const outer = await db.withTenant(practice, (sql) =>
      searchClinical(
        spyTable(sql, "search_doc", () => (searchDocQueries += 1)),
        input
      )
    );
    const counters = { searchDocQueries, fetchCalls: fetch.count() };
    if (!outer.ok) return { ok: false, error: outer.error.code, ...counters };
    const inner = outer.data;
    if (!inner.ok) return { ok: false, error: inner.error.code, ...counters };
    return { ok: true, response: inner.data, ...counters };
  } finally {
    fetch.restore();
    await db.end();
  }
}

async function runCcp(practice: string, input: unknown): Promise<CcpOutcome> {
  const db = connectTenantDb();
  const fetch = installFetchSpy();
  let fhirResourceReads = 0;
  let searchDocQueries = 0;
  try {
    const outer = await db.withTenant(practice, (sql) =>
      buildCcp(
        spyReads(
          sql,
          () => (fhirResourceReads += 1),
          () => (searchDocQueries += 1)
        ),
        input
      )
    );
    const counters = { fhirResourceReads, searchDocQueries, fetchCalls: fetch.count() };
    if (!outer.ok) return { ok: false, error: outer.error.code, ...counters };
    const inner = outer.data;
    if (!inner.ok) return { ok: false, error: inner.error.code, ...counters };
    const tokenRatio = measureCcp(inner.data).ratio;
    return { ok: true, doc: inner.data, tokenRatio, ...counters };
  } finally {
    fetch.restore();
    await db.end();
  }
}

async function main(): Promise<number> {
  const jobArg = process.argv[2];
  if (jobArg === undefined) {
    process.stderr.write("usage: run.ts '<job-json>'\n");
    return 1;
  }
  const job = jobSchema.parse(JSON.parse(jobArg) as unknown);
  if (job.cmd === "seed") {
    process.stdout.write(
      `${JSON.stringify({ seeded: await runSeed(job.practice, job.corpus) })}\n`
    );
  } else if (job.cmd === "search") {
    process.stdout.write(`${JSON.stringify(await runSearch(job.practice, job.input))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await runCcp(job.practice, job.input))}\n`);
  }
  return 0;
}

process.exitCode = await main();
