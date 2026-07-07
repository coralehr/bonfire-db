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
 *
 * argv[2] = a JSON job. stdout = one JSON line. Exit 0 unless the job is unreadable.
 */
import { z } from "zod";
import type { SearchResponse, TenantSql } from "../../packages/core/src/index.js";
import {
  connectTenantDb,
  indexResourceTx,
  insertFhirResourceTx,
  searchClinical
} from "../../packages/core/src/index.js";

const docSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  content: z.record(z.string(), z.unknown())
});
const jobSchema = z.object({
  cmd: z.enum(["seed", "search"]),
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

/** Wrap the tenant sql so a tagged-template read of `search_doc` bumps the counter. */
function spySearchDoc(real: TenantSql, onSearchDoc: () => void): TenantSql {
  return new Proxy(real, {
    apply(target, thisArg, args): unknown {
      const first: unknown = args[0];
      if (Array.isArray(first) && first.join(" ").includes("search_doc")) onSearchDoc();
      return Reflect.apply(target, thisArg, args);
    }
  });
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
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let searchDocQueries = 0;
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };
  try {
    const outer = await db.withTenant(practice, (sql) =>
      searchClinical(
        spySearchDoc(sql, () => (searchDocQueries += 1)),
        input
      )
    );
    if (!outer.ok) return { ok: false, error: outer.error.code, searchDocQueries, fetchCalls };
    const inner = outer.data;
    if (!inner.ok) return { ok: false, error: inner.error.code, searchDocQueries, fetchCalls };
    return { ok: true, response: inner.data, searchDocQueries, fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
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
  } else {
    process.stdout.write(`${JSON.stringify(await runSearch(job.practice, job.input))}\n`);
  }
  return 0;
}

process.exitCode = await main();
