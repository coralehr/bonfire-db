/**
 * Append N audit rows for one practice through the PRODUCT write path
 * (@bonfire/core authorizeAndAudit), for the bf05 tamper eval to then verify
 * with its INDEPENDENT chain oracle. Operator-run dev surface (like
 * scripts/sql-on-fhir/rebuild.ts): the eval is on the harness side of the
 * firewall and cannot import product code, so it shells out to this script —
 * which makes the eval a genuine CROSS-IMPLEMENTATION check (independent
 * walker over product-written row_hashes), closing the hash-spec-drift class.
 *
 * argv: <practiceUuid> <count>. Alternating allow/deny scopes for that practice.
 */
import { authorizeAndAudit, connectTenantDb } from "../../packages/core/src/index.js";

const CLINICAL_TYPE = "Observation";
const DEFAULT_COUNT = 3;

function allowScope(practice: string): unknown {
  return {
    subject: { id: "audit-demo-clinician", role: "clinician", practiceId: practice },
    resource: { resourceType: CLINICAL_TYPE, practiceId: practice },
    purposeOfUse: "TREAT",
    requestPracticeId: practice
  };
}

function denyScope(practice: string): unknown {
  return {
    subject: { id: "audit-demo-biller", role: "biller", practiceId: practice },
    resource: { resourceType: CLINICAL_TYPE, practiceId: practice },
    purposeOfUse: "HPAYMT",
    requestPracticeId: practice
  };
}

async function main(): Promise<number> {
  const [practice, countArg] = process.argv.slice(2);
  if (practice === undefined) {
    process.stderr.write("usage: append.ts <practiceUuid> [count]\n");
    return 1;
  }
  const count = countArg === undefined ? DEFAULT_COUNT : Number(countArg);
  const db = connectTenantDb();
  try {
    const result = await db.withTenant(practice, async (sql) => {
      for (let i = 0; i < count; i += 1) {
        const scope = i % 2 === 0 ? allowScope(practice) : denyScope(practice);
        await authorizeAndAudit(sql, scope);
      }
      return count;
    });
    if (!result.ok) {
      process.stderr.write(`append failed: [${result.error.code}] ${result.error.message}\n`);
      return 1;
    }
    process.stdout.write(`appended ${String(result.data)} rows for ${practice}\n`);
    return 0;
  } finally {
    await db.end();
  }
}

process.exitCode = await main();
