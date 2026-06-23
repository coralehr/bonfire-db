import { spawnSync } from "node:child_process";

import {
  AppendOnlyAuditLedger,
  BonfireAccessDenied,
  readPatientWithPolicy,
  verifyAuditHashChain
} from "@bonfire/core";

const practiceId = "11111111-1111-4111-8111-111111111111";
const allowedClinician = {
  id: "22222222-2222-4222-8222-222222222201",
  practiceId,
  role: "clinician" as const
};
const wrongClinician = {
  id: "22222222-2222-4222-8222-222222222299",
  practiceId: "99999999-9999-4999-8999-999999999999",
  role: "clinician" as const
};
const patient = {
  id: "33333333-3333-4333-8333-333333333301",
  practiceId
};
const roster = [
  {
    practiceId,
    actorId: allowedClinician.id,
    patientId: patient.id,
    relationship: "primary_clinician"
  }
] as const;
const consents = [
  {
    practiceId,
    patientId: patient.id,
    scope: "demo-treatment",
    status: "active" as const
  }
] as const;

function fail(message: string): never {
  console.error(`smoke:policy FAIL ${message}`);
  process.exit(1);
}

function runPsql(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "bonfire", "-d", "bonfire", ...args],
    { encoding: "utf8" }
  );

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`
  };
}

function expectPsqlScalar(sql: string, expected: string): void {
  const result = runPsql(["-At", "-c", sql]);
  if (result.status !== 0) fail(result.output.trim() || "psql scalar failed");
  if (result.output.trim() !== expected) {
    fail(`expected ${expected} from ${sql}, got ${result.output.trim()}`);
  }
}

function expectAppendOnlyFailure(label: "UPDATE" | "DELETE", sql: string): void {
  const result = runPsql(["-c", sql]);
  if (result.status === 0) fail(`${label} unexpectedly succeeded`);
  if (!result.output.includes("audit_events is append-only")) {
    fail(`${label} failed without append-only error: ${result.output.trim()}`);
  }
}

const audit = new AppendOnlyAuditLedger();

readPatientWithPolicy({
  actor: allowedClinician,
  patient,
  roster,
  consents,
  audit
});

try {
  readPatientWithPolicy({
    actor: wrongClinician,
    patient,
    roster,
    consents,
    audit
  });
  fail("wrong clinician read was allowed");
} catch (error) {
  if (!(error instanceof BonfireAccessDenied)) throw error;
}

const chain = verifyAuditHashChain(audit.list());
if (!chain.valid) fail(`hash chain invalid at index ${chain.index}`);

expectPsqlScalar("SELECT count(*) FROM audit_events WHERE seed_key = 'bf02-seed-load'", "1");
expectAppendOnlyFailure(
  "UPDATE",
  "UPDATE audit_events SET reason = reason WHERE seed_key = 'bf02-seed-load'"
);
expectAppendOnlyFailure(
  "DELETE",
  "DELETE FROM audit_events WHERE seed_key = 'bf02-seed-load'"
);

console.log("smoke:policy PASS");
