/**
 * Execution eval bf07-citation-resolves (BF-07 acceptance 3).
 *
 * Citation precision = 1.0: seed a multi-type corpus (Patient + Condition +
 * Observation), run a REAL search, build the CCP, then for EVERY emitted span
 * re-resolve its (resourceId, jsonPath) against canonical fhir_resources as the
 * migration OWNER (RLS-exempt) via `content #> string_to_array(jsonPath,'.')`
 * and assert the resolved leaf equals the span's projected value under
 * canonical-JSON equality — both sides through JSON.parse, never `#>>` text, so
 * a numeric leaf (1.40 vs 1.4) still compares equal. Every span must resolve and
 * match, across at least the three seeded types, or precision drops below 1.0.
 *
 * Inversion: diverging the projected value from the cited leaf (e.g. corrupting
 * the value in extractGroup so span.value != content #> jsonPath) -> a span no
 * longer re-resolves to its own citation -> red.
 */
import postgres from "postgres";
import { buildCcpDoc, condition, type Doc, valueObservation } from "./bf07-ccp-util.js";
import { fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf07-citation-resolves";
const TOKEN = "zzcite";
/** A non-integer lab value exercises the 1.40-vs-1.4 canonical-equality path. */
const NON_INTEGER_VALUE = 1.4;
const practice = crypto.randomUUID();
const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });

/** A Patient carrying the query token as a searchable name (no util helper exists). */
function patient(): Doc {
  const id = crypto.randomUUID();
  return {
    id,
    type: "Patient",
    content: {
      resourceType: "Patient",
      id,
      name: [{ family: TOKEN, given: ["Synthetic"] }],
      birthDate: "1990-02-03"
    }
  };
}

const corpus: readonly Doc[] = [
  patient(),
  condition(`${TOKEN} cardiac finding`, `${TOKEN} clinical note`),
  valueObservation(`${TOKEN} lab result`, NON_INTEGER_VALUE)
];

try {
  const { doc } = buildCcpDoc(EVAL_ID, practice, corpus, TOKEN);
  const types = new Set(doc.spans.map((span) => span.resourceType));
  for (const expected of ["Patient", "Condition", "Observation"]) {
    if (!types.has(expected))
      fail(EVAL_ID, `no ${expected} span in the CCP (types: ${[...types].join(",")})`);
  }

  let matched = 0;
  for (const span of doc.spans) {
    const rows = (await owner`
      select (content #> string_to_array(${span.jsonPath}, '.'))::text as val
      from fhir_resources where id = ${span.resourceId}`) as unknown as { val: string | null }[];
    const val = rows[0]?.val;
    if (val === undefined || val === null)
      fail(
        EVAL_ID,
        `span ${span.resourceId}#${span.jsonPath} did not re-resolve in fhir_resources`
      );
    // Canonical-JSON equality: both sides through JSON.parse so 1.40 == 1.4.
    if (JSON.stringify(JSON.parse(val)) !== JSON.stringify(span.value))
      fail(
        EVAL_ID,
        `citation ${span.resourceId}#${span.jsonPath}: projected ${JSON.stringify(span.value)} != canonical ${val}`
      );
    matched += 1;
  }

  const precision = matched / doc.spans.length;
  if (precision !== 1)
    fail(
      EVAL_ID,
      `citation precision ${String(precision)} (${String(matched)}/${String(doc.spans.length)})`
    );

  pass(
    EVAL_ID,
    `citation precision 1.0: all ${String(doc.spans.length)} spans across ${String(types.size)} types re-resolve to their cited leaf`
  );
} finally {
  await owner.end({ timeout: 5 });
}
