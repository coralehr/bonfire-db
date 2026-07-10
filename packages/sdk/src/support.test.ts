/**
 * Shared DB-backed helpers for the @bonfire/sdk test battery. Named *.test.ts
 * so the raw postgres owner client stays inside the tests-only exemption of
 * the tenant-boundary sgrule; it deliberately defines no tests of its own.
 * All identities and clinical values are synthetic.
 */
import { randomUUID } from "node:crypto";
import type { Role, TenantDb, VerifiedIdentity, Verifier } from "@bonfire/core";
import { devDatabaseUrl, ok } from "@bonfire/core";
import postgres from "postgres";
import type { BonfireSession } from "./auth/session.js";
import { authenticate } from "./auth/session.js";

export const TEST_ISS = "https://idp.synthetic.test/sdk";

/** The migrate-role client used to seed membership (app role has REVOKE INSERT). */
export function ownerClient(): postgres.Sql {
  return postgres(devDatabaseUrl("migrate"), { max: 1 });
}

/** A verifier stub that accepts any token as `identity` (no jose, no network). */
export function okVerifier(identity: VerifiedIdentity): Verifier {
  return { verifyToken: () => Promise.resolve(ok(identity)) };
}

/** A synthetic bearer token built at runtime (never a literal secret). */
export function syntheticToken(): string {
  return ["tok", randomUUID()].join("-");
}

export interface SeededSession {
  readonly session: BonfireSession;
  readonly sub: string;
}

/**
 * Seed a membership row for a fresh synthetic subject in `practiceId` and
 * authenticate against it through the REAL authenticate() path.
 */
export async function sessionFor(
  db: TenantDb,
  owner: postgres.Sql,
  practiceId: string,
  role: Role
): Promise<SeededSession> {
  const sub = `sdk-user-${randomUUID()}`;
  await owner`insert into membership (iss, sub, practice_id, role)
    values (${TEST_ISS}, ${sub}, ${practiceId}, ${role})`;
  const authed = await authenticate({
    db,
    verifier: okVerifier({ iss: TEST_ISS, sub }),
    token: syntheticToken()
  });
  if (!authed.ok) throw new Error(`authenticate failed: ${authed.error.code}`);
  return { session: authed.data, sub };
}
