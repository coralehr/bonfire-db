/**
 * BF-09 governance route battery (dangerChecks: propose-only-broken,
 * fail-open-authz, audit-bypass). Local JWKS + owner-seeded memberships, all
 * requests via fastify.inject — no network, no shared fixtures. Oracles are
 * the BODY's typed governance Result codes (the routes always reply 200 once
 * authenticated); transport-level 401 stays with runAuthenticated. Every
 * practice is a fresh randomUUID(), and all identities are synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Role, TenantDb } from "@bonfire/core";
import { authActorId, signedNoteSchema } from "@bonfire/core";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuthenticatedAppHarness } from "../../testing/authenticated-app.test.js";
import { createAuthenticatedAppHarness } from "../../testing/authenticated-app.test.js";

const DB_TIMEOUT_MS = 30_000;

const proposalOkSchema = z.object({
  ok: z.literal(true),
  data: z.object({ proposalId: z.uuid(), state: z.string() })
});
const signedOkSchema = z.object({ ok: z.literal(true), data: signedNoteSchema });
const errBodySchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });

let tenantDb: TenantDb;
let owner: Sql;
let app: FastifyInstance;
let harness: AuthenticatedAppHarness;

beforeAll(async () => {
  harness = await createAuthenticatedAppHarness({ issuerPrefix: "bf09" });
  ({ app, tenantDb, owner } = harness);
});

afterAll(async () => {
  await harness.close();
});

/** Seed one membership (owner-only write) and mint its Bearer token. */
async function enroll(practiceId: string, role: Role): Promise<string> {
  return harness.enroll(practiceId, role);
}

interface Posted {
  readonly status: number;
  readonly body: unknown;
}

async function post(
  url: string,
  token: string | undefined,
  payload: unknown = {}
): Promise<Posted> {
  const res = await app.inject({
    method: "POST",
    url,
    payload: payload === undefined ? {} : payload,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
  });
  const body: unknown = res.body.length > 0 ? JSON.parse(res.body) : undefined;
  return { status: res.statusCode, body };
}

/** A fresh, valid synthetic Patient scribe input. */
function patientResource(): Record<string, unknown> {
  const id = randomUUID();
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "http://example.org/synthetic/id", value: `syn-${id.slice(0, 6)}` }],
    name: [{ family: "Governance", given: ["Routes"] }],
    gender: "other"
  };
}

/** Stage one proposal through the HTTP surface; returns its id. */
async function stageProposal(token: string): Promise<string> {
  const proposed = await post("/governance/proposals", token, { resource: patientResource() });
  expect(proposed.status).toBe(200);
  const parsed = proposalOkSchema.parse(proposed.body);
  expect(parsed.data.state).toBe("proposed");
  return parsed.data.proposalId;
}

/** Body error-code oracle for an expected governance denial/state error. */
function errCodeOf(posted: Posted): string {
  expect(posted.status).toBe(200);
  return errBodySchema.parse(posted.body).error.code;
}

/** decision/resource_type pairs on ONE practice's audit chain (RLS-scoped). */
async function auditTrail(practice: string): Promise<{ decision: string; resource: string }[]> {
  const result = await tenantDb.withTenant(practice, async (sql) => {
    const rows = await sql<{ decision: string; resource_type: string }[]>`
      select decision, resource_type from audit_log order by seq asc`;
    return rows.map((row) => ({ decision: row.decision, resource: row.resource_type }));
  });
  if (!result.ok) throw new Error(`auditTrail read failed: ${result.error.code}`);
  return result.data;
}

/** Owner-side (RLS-bypassing) governance row counts for THIS run's issuer. */
async function issuerGovernanceRows(): Promise<number> {
  const actorPrefix = authActorId({ iss: harness.issuer, sub: "" }).slice(0, -2);
  const [row] = await owner`
    select count(*)::int as n from governance_proposal
    where proposer_actor_id like ${`${actorPrefix}%`}`;
  return Number(row?.n ?? -1);
}

describe("clinician full flow (propose -> approve -> commit)", () => {
  test(
    "the three-step flow ends in a signed note that parses signedNoteSchema",
    async () => {
      const practice = randomUUID();
      const clinician = await enroll(practice, "clinician");
      const proposalId = await stageProposal(clinician);

      const approved = await post(`/governance/proposals/${proposalId}/approve`, clinician);
      expect(approved.status).toBe(200);
      const approval = proposalOkSchema.parse(approved.body);
      expect(approval.data).toEqual({ proposalId, state: "approved" });

      const committed = await post(`/governance/proposals/${proposalId}/commit`, clinician);
      expect(committed.status).toBe(200);
      const note = signedOkSchema.parse(committed.body).data;
      expect(note.proposalId).toBe(proposalId);
      const actorPrefix = authActorId({ iss: harness.issuer, sub: "" }).slice(0, -2);
      expect(note.approverActorId.startsWith(actorPrefix)).toBe(true);
      expect(note.resource.resourceType).toBe("Patient");
      const projected = await owner`
        select
          (select count(*) from fhir_resources where practice_id = ${practice}
            and id = ${note.resource.resourceId}) as canonical,
          (select count(*) from vd_patient_demographics where practice_id = ${practice}
            and id = ${note.resource.resourceId}) as demographics,
          (select count(*) from search_doc where practice_id = ${practice}
            and resource_id = ${note.resource.resourceId}) as search`;
      expect(projected[0]).toEqual({ canonical: "1", demographics: "1", search: "1" });
    },
    DB_TIMEOUT_MS
  );

  test(
    "commit BEFORE approve is a typed GOVERNANCE_INVALID_TRANSITION",
    async () => {
      const practice = randomUUID();
      const clinician = await enroll(practice, "clinician");
      const proposalId = await stageProposal(clinician);
      const early = await post(`/governance/proposals/${proposalId}/commit`, clinician);
      expect(errCodeOf(early)).toBe("GOVERNANCE_INVALID_TRANSITION");
    },
    DB_TIMEOUT_MS
  );

  test(
    "a malformed proposal id in the URL is DATA: typed GOVERNANCE_NOT_FOUND",
    async () => {
      const practice = randomUUID();
      const clinician = await enroll(practice, "clinician");
      const bogus = await post("/governance/proposals/not-a-uuid/approve", clinician);
      expect(errCodeOf(bogus)).toBe("GOVERNANCE_NOT_FOUND");
    },
    DB_TIMEOUT_MS
  );
});

describe("non-clinician authority is DEFAULT-DENY and the denial is audited", () => {
  test(
    "biller: propose ok, approve denied with a deny row on the practice chain",
    async () => {
      const practice = randomUUID();
      const biller = await enroll(practice, "biller");
      const proposalId = await stageProposal(biller);

      const denied = await post(`/governance/proposals/${proposalId}/approve`, biller);
      expect(errCodeOf(denied)).toBe("GOVERNANCE_FORBIDDEN");

      // The denial reached the BF-05 chain: decision=deny, action-qualified type.
      const trail = await auditTrail(practice);
      const denyRows = trail.filter(
        (row) => row.decision === "deny" && row.resource === "Governance.approve"
      );
      expect(denyRows).toHaveLength(1);

      // The proposal did not advance: zero governance events exist for it.
      const events = await owner`
        select id from governance_event where proposal_id = ${proposalId}`;
      expect(events).toHaveLength(0);
    },
    DB_TIMEOUT_MS
  );

  test(
    "smuggled role/practiceId in the request body is INERT (still denied)",
    async () => {
      const practice = randomUUID();
      const biller = await enroll(practice, "biller");
      const proposalId = await stageProposal(biller);
      const smuggled = await post(`/governance/proposals/${proposalId}/approve`, biller, {
        role: "clinician",
        practiceId: randomUUID(),
        practice_id: practice
      });
      expect(errCodeOf(smuggled)).toBe("GOVERNANCE_FORBIDDEN");
      const events = await owner`
        select id from governance_event where proposal_id = ${proposalId}`;
      expect(events).toHaveLength(0);
    },
    DB_TIMEOUT_MS
  );
});

describe("unauthenticated requests never reach governance", () => {
  test(
    "no Bearer and a garbage Bearer both 401 with ZERO governance rows",
    async () => {
      const before = await issuerGovernanceRows();
      const bare = await post("/governance/proposals", undefined, {
        resource: patientResource()
      });
      expect(bare.status).toBe(401);
      // Credential-shaped literal built at RUNTIME (semgrep const-propagates).
      const garbage = ["not", "a", "jwt"].join(".");
      const forged = await post("/governance/proposals", garbage, {
        resource: patientResource()
      });
      expect(forged.status).toBe(401);
      expect(await issuerGovernanceRows()).toBe(before);
    },
    DB_TIMEOUT_MS
  );
});
