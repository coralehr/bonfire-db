/**
 * scripts/auth-demo/authenticate.ts — an operator dev surface that drives the
 * BF-13 product authentication path headlessly, so the bf13 Stage-2 evals can
 * assert against a real @bonfire/core build across the harness<->product
 * firewall.
 *
 * The evals live on the harness side and cannot import product code; they forge
 * synthetic tokens with jose, then shell out to THIS script, which composes the
 * exact primitives `runAuthenticated` uses — verifyToken -> resolveMembership ->
 * auditAuthSuccess/Failure — and prints the outcome as one JSON line. Membership
 * rows are owner-seeded by the caller (bonfire_app cannot INSERT membership, the
 * trust anchor), so this script only READS membership and WRITES audit as app.
 *
 * argv[2] = a JSON job (see jobSchema). stdout = one JSON AuthOutcome line. Exit
 * 0 unless the job itself is unreadable: a verification or authorization DENY is
 * a STRUCTURED outcome, never a non-zero exit (fail-closed is data, not a crash).
 */

import type { JSONWebKeySet } from "jose";
import { createLocalJWKSet } from "jose";
import { z } from "zod";
import type {
  AuthFailure,
  Membership,
  TenantDb,
  VerifiedIdentity,
  VerifyTokenConfig
} from "../../packages/core/src/index.js";
import {
  auditAuthFailure,
  auditAuthSuccess,
  connectTenantDb,
  verifyToken
} from "../../packages/core/src/index.js";

function isJwks(value: unknown): value is JSONWebKeySet {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys)
  );
}

const jobSchema = z.object({
  token: z.string(),
  jwks: z.custom<JSONWebKeySet>(isJwks, "jwks must be a JSON Web Key Set"),
  config: z.object({
    issuer: z.string(),
    jwksUri: z.string(),
    audience: z.string(),
    algorithms: z.array(z.string()),
    clockToleranceSeconds: z.number(),
    claimNames: z.object({ fhirUser: z.string() }).optional()
  }),
  resolve: z.boolean(),
  audit: z.boolean()
});
type Job = z.infer<typeof jobSchema>;

interface AuditReport {
  readonly decision: "allow" | "deny";
  readonly auditRowHash: string;
  readonly practiceId?: string;
}
type VerifyReport =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly code: string };
type MembershipReport =
  | null
  | "none"
  | { readonly practiceId: string; readonly role: string }
  | { readonly error: string };
interface AuthOutcome {
  readonly verify: VerifyReport;
  readonly membership: MembershipReport;
  readonly audit: AuditReport | { readonly error: string } | null;
}

/** Build the VerifyTokenConfig, omitting claimNames when absent (exactOptional). */
function toConfig(c: Job["config"]): VerifyTokenConfig {
  const base = {
    issuer: c.issuer,
    jwksUri: c.jwksUri,
    audience: c.audience,
    algorithms: c.algorithms,
    clockToleranceSeconds: c.clockToleranceSeconds
  };
  return c.claimNames === undefined ? base : { ...base, claimNames: c.claimNames };
}

async function recordFailure(db: TenantDb, failure: AuthFailure): Promise<AuthOutcome["audit"]> {
  const audited = await auditAuthFailure(db, failure);
  return audited.ok
    ? { decision: "deny", auditRowHash: audited.data.auditRowHash }
    : { error: audited.error.code };
}

async function recordSuccess(
  db: TenantDb,
  identity: VerifiedIdentity,
  membership: Membership
): Promise<AuthOutcome["audit"]> {
  const audited = await auditAuthSuccess(db, identity, membership);
  return audited.ok
    ? {
        decision: "allow",
        auditRowHash: audited.data.auditRowHash,
        practiceId: membership.practiceId
      }
    : { error: audited.error.code };
}

/** verify ok -> resolve membership server-side, then audit the resolved decision. */
async function authorize(
  db: TenantDb,
  job: Job,
  identity: VerifiedIdentity,
  verify: VerifyReport
): Promise<AuthOutcome> {
  const resolved = await db.resolveMembership(identity.iss, identity.sub);
  if (!resolved.ok) return { verify, membership: { error: resolved.error.code }, audit: null };
  if (resolved.data === null) {
    const audit = job.audit ? await recordFailure(db, { kind: "no-membership", identity }) : null;
    return { verify, membership: "none", audit };
  }
  const membership = resolved.data;
  const audit = job.audit ? await recordSuccess(db, identity, membership) : null;
  return {
    verify,
    membership: { practiceId: membership.practiceId, role: membership.role },
    audit
  };
}

async function run(job: Job): Promise<AuthOutcome> {
  const verified = await verifyToken(job.token, toConfig(job.config), createLocalJWKSet(job.jwks));
  const verify: VerifyReport = verified.ok
    ? { ok: true, identity: verified.data }
    : { ok: false, code: verified.error.code };
  if (!job.resolve) return { verify, membership: null, audit: null };

  const db = connectTenantDb();
  try {
    if (!verified.ok) {
      const audit = job.audit
        ? await recordFailure(db, { kind: "verify", code: verified.error.code })
        : null;
      return { verify, membership: null, audit };
    }
    return await authorize(db, job, verified.data, verify);
  } finally {
    await db.end();
  }
}

async function main(): Promise<number> {
  const jobArg = process.argv[2];
  if (jobArg === undefined) {
    process.stderr.write("usage: authenticate.ts '<job-json>'\n");
    return 1;
  }
  const job = jobSchema.parse(JSON.parse(jobArg) as unknown);
  process.stdout.write(`${JSON.stringify(await run(job))}\n`);
  return 0;
}

process.exitCode = await main();
