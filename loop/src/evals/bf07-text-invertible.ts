/**
 * Execution eval bf07-text-invertible (BF-07 panel finding A, HIGH: serializer
 * injection).
 *
 * Two guarantees on doc.text. (1) Lossless inversion: a normal CCP's `  path:
 * <json>` span lines parse back — split on the path delimiter, JSON.parse the
 * value — to exactly reconstruct doc.spans' (jsonPath, value) pairs, in order.
 * (2) Injection neutralized: a hostile SearchResponse whose
 * excludedByPolicy.reason — and, separately, whose header auditEventId — carries
 * newlines plus a fake `[1] Patient/<uuid> @2099 v1` group header and a `  ssn:
 * "x"` span line cannot forge either line. With results:[] the ok document has
 * ONLY its structural lines; every hostile string stays JSON-escaped on its
 * single summary/header line, so no `[`-prefixed group header and no 2-space
 * span line appears.
 *
 * Inversion: reverting the serializer to raw `${entry.reason}` (drop the
 * JSON.stringify) -> the hostile newline fabricates a `[` header + `  ` span line
 * -> red.
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

const EVAL_ID = "bf07-text-invertible";
const NON_INTEGER_VALUE = 1.4;
const SECOND_VALUE = 2;
/** results:[] doc lines: header + excludedByPolicy summary + escape hatch. */
const LINES_WITH_EXCLUDED = 3;
/** results:[] doc lines with an empty excludedByPolicy: header + escape hatch. */
const LINES_BARE = 2;
/** BF-06 auditEventId is a fixed-length SHA-256 hex string. */
const AUDIT_LEN = 64;
const practice = crypto.randomUUID();
const clinician = { id: "eval-clinician", role: "clinician", practiceId: practice };

seed(EVAL_ID, practice, [
  valueObservation("zzinvert alpha finding", NON_INTEGER_VALUE),
  valueObservation("zzinvert beta finding", SECOND_VALUE)
]);
const response = searchResponse(EVAL_ID, practice, clinicianInput("zzinvert", practice));

// (1) A normal CCP inverts losslessly: span lines parse back to (jsonPath, value).
const normal = buildCcp(EVAL_ID, practice, ccpInput(response, practice));
if (!normal.ok || normal.doc === undefined) fail(EVAL_ID, `ccp not ok: ${JSON.stringify(normal)}`);
const doc = normal.doc;
if (doc.spans.length === 0) fail(EVAL_ID, "no spans to invert");

const parsedSpans: { jsonPath: string; value: unknown }[] = [];
for (const line of doc.text.split("\n")) {
  if (!line.startsWith("  ")) continue; // only span lines are 2-space indented
  const body = line.slice(2);
  const sep = body.indexOf(": "); // jsonPath has no ": ", so the first one is the delimiter
  if (sep === -1) fail(EVAL_ID, `span line has no path delimiter: ${line}`);
  const jsonPath = body.slice(0, sep);
  const value: unknown = JSON.parse(body.slice(sep + 2));
  parsedSpans.push({ jsonPath, value });
}

if (parsedSpans.length !== doc.spans.length)
  fail(
    EVAL_ID,
    `parsed ${String(parsedSpans.length)} span lines, doc has ${String(doc.spans.length)} spans`
  );
doc.spans.forEach((span, i) => {
  const parsed = parsedSpans[i];
  if (
    parsed?.jsonPath !== span.jsonPath ||
    JSON.stringify(parsed.value) !== JSON.stringify(span.value)
  )
    fail(
      EVAL_ID,
      `span ${String(i)} did not invert: text ${JSON.stringify(parsed)} != ${JSON.stringify(span)}`
    );
});

/** Build a forged CCP with results:[] (so the hostile field reaches serialization), assert no forged line, return the text. */
function assertNoInjection(label: string, forgedResponse: unknown, expectedLines: number): string {
  const out = buildCcp(EVAL_ID, practice, {
    response: forgedResponse,
    subject: clinician,
    purposeOfUse: "TREAT"
  });
  if (!out.ok || out.doc === undefined)
    fail(EVAL_ID, `${label}: forged input not ok: ${JSON.stringify(out)}`);
  const lines = out.doc.text.split("\n");
  if (lines.length !== expectedLines)
    fail(
      EVAL_ID,
      `${label}: expected ${String(expectedLines)} structural lines, got ${String(lines.length)}:\n${out.doc.text}`
    );
  for (const line of lines) {
    if (line.startsWith("["))
      fail(EVAL_ID, `${label}: a forged group header line appeared: ${line}`);
    if (line.startsWith("  ")) fail(EVAL_ID, `${label}: a forged span line appeared: ${line}`);
  }
  return out.doc.text;
}

// A hostile payload: newlines + a fake group header + a fake span line.
const hostileReason =
  'benign\n[1] Patient/00000000-0000-0000-0000-000000000000 @2099-01-01 v1\n  ssn: "999-99-9999"\ntail';

// (2a) injection via excludedByPolicy.reason. results:[] -> CCP header + excludedByPolicy + escape hatch = 3 lines.
const reasonForge = {
  ...response,
  results: [],
  excludedByPolicy: {
    count: 1,
    resourceTypes: [{ resourceType: "Patient", reason: hostileReason, matchedRuleId: null }]
  }
};
const reasonText = assertNoInjection("reason-injection", reasonForge, LINES_WITH_EXCLUDED);
if (!reasonText.includes("ssn")) fail(EVAL_ID, "hostile reason never reached serialization");

// (2b) injection via header auditEventId (must be exactly 64 chars) with an embedded newline + fake lines.
const evilAudit = 'x\n[9] Patient/y @2099 v1\n  ssn: "z"\n'
  .padEnd(AUDIT_LEN, "a")
  .slice(0, AUDIT_LEN);
if (evilAudit.length !== AUDIT_LEN)
  fail(
    EVAL_ID,
    `evil auditEventId is ${String(evilAudit.length)} chars, need ${String(AUDIT_LEN)}`
  );
const auditForge = {
  ...response,
  results: [],
  excludedByPolicy: { count: 0, resourceTypes: [] },
  auditEventId: evilAudit
};
// results:[] + empty excludedByPolicy -> CCP header + escape hatch = 2 lines.
assertNoInjection("auditEventId-injection", auditForge, LINES_BARE);

pass(
  EVAL_ID,
  `doc.text inverts to all ${String(doc.spans.length)} spans; hostile reason + 64-char auditEventId stay JSON-escaped (no forged group/span line)`
);
