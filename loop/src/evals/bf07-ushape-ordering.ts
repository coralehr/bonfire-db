/**
 * Execution eval bf07-ushape-ordering (BF-07 acceptance 5).
 *
 * The CCP emits resource groups in the documented U-shape of the search rank
 * order: rank 1 first, rank 2 last, rank 3 second, ... (highest salience at both
 * edges). Asserted against the REAL search ranking (read from the response, not
 * guessed) so the check is independent of which synthetic doc ranks where; the
 * expected permutation is recomputed from the rank order and compared to the
 * doc's group emission order. Determinism is also confirmed (two builds byte-match).
 *
 * Inversion: emitting groups in plain rank order (drop the front/back split) -> red.
 */
import {
  buildCcp,
  ccpInput,
  clinicianInput,
  searchResponse,
  seed,
  valueObservation
} from "./bf07-ccp-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf07-ushape-ordering";
const CORPUS_SIZE = 6;
/** Minimum ranked results for a meaningful U-shape (front + middle + back). */
const MIN_RANKED = 4;
const practice = crypto.randomUUID();

/**
 * The expected U-shape of a rank order, computed INDEPENDENTLY of ccp/ushape.ts
 * (the harness cannot import product code): even-rank items in order, then the
 * odd-rank items reversed — equivalent to the product's front-push/back-unshift,
 * proven by asserting the doc's real group order against this.
 */
function expectedUShape<T>(ranked: readonly T[]): T[] {
  const evens = ranked.filter((_item, index) => index % 2 === 0);
  const odds = ranked.filter((_item, index) => index % 2 === 1).reverse();
  return [...evens, ...odds];
}

/** Unique resourceIds in the order their spans are emitted (= group order). */
function groupOrder(spans: readonly { readonly resourceId: string }[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const span of spans) {
    if (!seen.has(span.resourceId)) {
      seen.add(span.resourceId);
      order.push(span.resourceId);
    }
  }
  return order;
}

const corpus = Array.from({ length: CORPUS_SIZE }, (_unused, i) =>
  valueObservation(`zzushape distinct clinical finding ${String(i)}`, i + 1)
);
seed(EVAL_ID, practice, corpus);

const response = searchResponse(EVAL_ID, practice, clinicianInput("zzushape", practice));
if (response.results.length < MIN_RANKED)
  fail(
    EVAL_ID,
    `need >=${String(MIN_RANKED)} ranked results, got ${String(response.results.length)}`
  );

const rankOrder = response.results.map((hit) => hit.resourceId);
const expected = expectedUShape(rankOrder);

const first = buildCcp(EVAL_ID, practice, ccpInput(response, practice));
if (!first.ok || first.doc === undefined) fail(EVAL_ID, `ccp not ok: ${JSON.stringify(first)}`);
const actual = groupOrder(first.doc.spans);
if (JSON.stringify(actual) !== JSON.stringify(expected))
  fail(EVAL_ID, `group order ${JSON.stringify(actual)} != U-shape ${JSON.stringify(expected)}`);

// Determinism: a second build over the same response is byte-identical text.
const second = buildCcp(EVAL_ID, practice, ccpInput(response, practice));
if (!second.ok || second.doc?.text !== first.doc.text)
  fail(EVAL_ID, "CCP text is not deterministic across identical builds");

pass(
  EVAL_ID,
  `groups emitted in U-shape of the rank order (${String(rankOrder.length)} items), deterministic`
);
