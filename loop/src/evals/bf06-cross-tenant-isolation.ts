/**
 * Execution eval bf06-cross-tenant-isolation (BF-06 acceptance 7; danger:
 * cross-tenant-leak).
 *
 * The IDENTICAL search term is seeded under two distinct practices. A search run
 * as practice A returns A's row and ZERO of B's — the search_doc FORCE-RLS policy
 * scopes every read to the bound GUC. A's own hit proves the term is findable
 * (non-vacuous).
 *
 * Inversion: dropping FORCE RLS / the tenant policy on search_doc surfaces B's row
 * in A's results -> red.
 */

import { clinicianInput, observation, search, seed } from "./bf06-search-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-cross-tenant-isolation";
const practiceA = crypto.randomUUID();
const practiceB = crypto.randomUUID();
const docA = observation("zzxtenant", "shared term note");
const docB = observation("zzxtenant", "shared term note");

seed(EVAL_ID, practiceA, [docA]);
seed(EVAL_ID, practiceB, [docB]);

const asA = search(EVAL_ID, practiceA, clinicianInput("zzxtenant", practiceA));
if (!asA.ok || asA.response === undefined)
  fail(EVAL_ID, `search as A failed: ${JSON.stringify(asA)}`);
const ids = asA.response.results.map((h) => h.resourceId);
if (!ids.includes(docA.id)) fail(EVAL_ID, `vacuous: practice A did not find its own row`);
if (ids.includes(docB.id))
  fail(EVAL_ID, `LEAK: practice A's search returned practice B's row ${docB.id}`);

pass(
  EVAL_ID,
  `practice A finds its own row and zero of practice B's (${String(ids.length)} hit(s))`
);
