/**
 * Execution eval bf06-citation-freshness (BF-06 acceptance 4).
 *
 * Every result carries a citation (resourceId + JSONB path + the audit row_hash)
 * and a freshness stamp (projection as-of); the citation's rowHash equals the
 * response's auditEventId (the single per-search audit event ties every hit).
 *
 * Inversion: dropping the citation/freshness stamp, or decoupling citation.rowHash
 * from auditEventId, -> red.
 */

import { clinicianInput, observation, search, seed } from "./bf06-search-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-citation-freshness";
const SHA256_HEX = 64;
const practice = crypto.randomUUID();
seed(EVAL_ID, practice, [observation("zzcite", "elevated glucose")]);

const out = search(EVAL_ID, practice, clinicianInput("zzcite", practice));
if (!out.ok || out.response === undefined) fail(EVAL_ID, `search failed: ${JSON.stringify(out)}`);
const r = out.response;
if (r.results.length === 0) fail(EVAL_ID, "vacuous: no results to carry a citation");
if (r.auditEventId.length !== SHA256_HEX)
  fail(EVAL_ID, `auditEventId not a 64-hex row_hash: ${r.auditEventId}`);
for (const hit of r.results) {
  const c = hit.citation;
  if (c.resourceId !== hit.resourceId)
    fail(EVAL_ID, `citation.resourceId != hit.resourceId: ${JSON.stringify(c)}`);
  if (c.path.length === 0) fail(EVAL_ID, `citation.path is empty for ${hit.resourceId}`);
  if (c.rowHash !== r.auditEventId)
    fail(EVAL_ID, `citation.rowHash != auditEventId for ${hit.resourceId}`);
  if (hit.freshness.lastUpdated.length === 0 || hit.freshness.versionId.length === 0) {
    fail(EVAL_ID, `freshness missing for ${hit.resourceId}: ${JSON.stringify(hit.freshness)}`);
  }
}

pass(
  EVAL_ID,
  `every hit carries {resourceId, path, rowHash===auditEventId} + freshness (${String(r.results.length)} hit(s))`
);
