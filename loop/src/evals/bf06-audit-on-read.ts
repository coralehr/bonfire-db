/**
 * Execution eval bf06-audit-on-read (BF-06 acceptance 7 aspect; danger:
 * audit-bypass).
 *
 * EVERY search — a normal hit, a zero-result search (an empty practice), and a
 * denied search — writes EXACTLY ONE append-only hash-chained audit row and
 * returns its row_hash as auditEventId. Verified independently over raw TCP as the
 * owner (RLS-exempt): the returned auditEventId is present exactly once with the
 * expected decision + Search resource_type + the bound practice_id.
 *
 * Inversion: a path that returns results (or a Result) without appending an audit
 * row -> the row_hash lookup returns zero -> red.
 */
import postgres from "postgres";
import { clinicianInput, observation, search, seed } from "./bf06-search-util.js";
import { fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf06-audit-on-read";
const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const practice = crypto.randomUUID();
const emptyPractice = crypto.randomUUID();

interface Row {
  readonly decision: string;
  readonly resource_type: string;
  readonly practice_id: string;
}

async function assertOne(hash: string, decision: string, expectedPractice: string): Promise<void> {
  const rows = (await owner`select decision, resource_type, practice_id::text as practice_id
    from audit_log where row_hash = ${hash}`) as unknown as Row[];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined)
    fail(EVAL_ID, `expected exactly 1 audit row for ${hash}, got ${String(rows.length)}`);
  if (
    row.decision !== decision ||
    row.resource_type !== "Search" ||
    row.practice_id !== expectedPractice
  ) {
    fail(EVAL_ID, `audit row wrong for ${decision}: ${JSON.stringify(row)}`);
  }
}

try {
  seed(EVAL_ID, practice, [observation("zzaudit", "a clinical note")]);

  const normal = search(EVAL_ID, practice, clinicianInput("zzaudit", practice));
  if (!normal.ok || normal.response === undefined || normal.response.results.length === 0)
    fail(EVAL_ID, "normal search had no results");
  await assertOne(normal.response.auditEventId, "allow", practice);

  // Zero-result: an allowed clinician/TREAT search over a practice with NO docs.
  const zero = search(EVAL_ID, emptyPractice, clinicianInput("zzaudit", emptyPractice));
  if (!zero.ok || zero.response?.results.length !== 0)
    fail(EVAL_ID, `zero-result search returned results: ${JSON.stringify(zero.response?.results)}`);
  await assertOne(zero.response.auditEventId, "allow", emptyPractice);

  const denyInput = {
    query: "zzaudit",
    subject: { id: "b1", role: "biller", practiceId: practice },
    purposeOfUse: "TREAT"
  };
  const deny = search(EVAL_ID, practice, denyInput);
  if (!deny.ok || deny.response === undefined)
    fail(EVAL_ID, `deny search failed: ${JSON.stringify(deny)}`);
  await assertOne(deny.response.auditEventId, "deny", practice);

  pass(
    EVAL_ID,
    "normal + zero-result (empty practice) + deny each wrote exactly one Search audit row"
  );
} finally {
  await owner.end({ timeout: 5 });
}
