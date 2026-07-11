/**
 * Shared DB-backed fixtures for the @bonfire/mcp test battery. Named *.test.ts
 * so the raw postgres owner client stays inside the tests-only exemptions; it
 * defines no tests of its own. All identities and clinical values are
 * synthetic.
 */
import { randomUUID } from "node:crypto";
import type { Role, TenantDb, Verifier } from "@bonfire/core";
import { devDatabaseUrl, indexResourceTx, insertFhirResourceTx, ok } from "@bonfire/core";
import type { BonfireSession } from "@bonfire/sdk";
import { authenticate } from "@bonfire/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { createBonfireMcpServer } from "./server.js";

export const MCP_ISS = "https://idp.synthetic.test/mcp";
const SEED_TRIES = 3;

/** The migrate-role client (membership INSERT is revoked from the app role). */
export function ownerSql(): postgres.Sql {
  return postgres(devDatabaseUrl("migrate"), { max: 1 });
}

export interface TenantFixture {
  readonly session: BonfireSession;
  readonly practiceId: string;
}

/** Mint a fresh practice + membership and authenticate a session for it. */
export async function newTenantSession(
  db: TenantDb,
  owner: postgres.Sql,
  role: Role
): Promise<TenantFixture> {
  const practiceId = randomUUID();
  const identity = { iss: MCP_ISS, sub: `mcp-agent-${randomUUID()}` };
  await owner`insert into membership ${owner({
    iss: identity.iss,
    sub: identity.sub,
    practice_id: practiceId,
    role
  })}`;
  const verifier: Verifier = { verifyToken: () => Promise.resolve(ok(identity)) };
  const outcome = await authenticate({ db, verifier, token: ["bearer", randomUUID()].join("-") });
  if (!outcome.ok) throw new Error(`mcp fixture authenticate failed: ${outcome.error.code}`);
  return { session: outcome.data, practiceId };
}

export interface McpFixture {
  readonly caller: Client;
  close(): Promise<void>;
}

/** A linked in-memory client/server pair over a per-session Bonfire server. */
export async function connectMcp(db: TenantDb, session: BonfireSession): Promise<McpFixture> {
  const server = createBonfireMcpServer({ db, session });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const caller = new Client({ name: "bf08-test-caller", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), caller.connect(clientTransport)]);
  return {
    caller,
    close: async (): Promise<void> => {
      await caller.close();
      await server.close();
    }
  };
}

/** Seed searchable synthetic Conditions (one per display) into a practice. */
export async function seedConditions(
  db: TenantDb,
  practiceId: string,
  displays: readonly string[]
): Promise<string[]> {
  const docs = displays.map((display) => {
    const id = randomUUID();
    return {
      id,
      content: {
        resourceType: "Condition",
        id,
        code: { coding: [{ system: "http://example.org/synthetic", code: "mcp-c1", display }] },
        clinicalStatus: { coding: [{ code: "active" }] }
      }
    };
  });
  let lastCode = "unknown";
  let attempt = 0;
  while (attempt < SEED_TRIES) {
    attempt += 1;
    const tx = await db.withTenant(practiceId, async (sql) => {
      for (const doc of docs) {
        const stored = await insertFhirResourceTx(sql, {
          id: doc.id,
          type: "Condition",
          content: doc.content,
          rawPayload: JSON.stringify(doc.content)
        });
        if (!stored.ok) throw new Error(stored.error.code);
      }
      for (const doc of docs) {
        const indexed = await indexResourceTx(sql, doc.id);
        if (!indexed.ok) throw new Error(indexed.error.code);
      }
    });
    if (tx.ok) return docs.map((doc) => doc.id);
    lastCode = tx.error.code;
    if (lastCode !== "TENANT_TX_FAILED") break;
  }
  throw new Error(`mcp corpus seed failed: ${lastCode}`);
}

export interface TenantFootprint {
  readonly audit: number;
  readonly fhir: number;
  readonly governance: number;
}

/** Row counts inside ONE practice — the side-effect oracle for deny paths. */
export async function tenantFootprint(db: TenantDb, practiceId: string): Promise<TenantFootprint> {
  const result = await db.withTenant(practiceId, async (sql) => {
    const [auditRow] = await sql`select count(*)::int as n from audit_log`;
    const [fhirRow] = await sql`select count(*)::int as n from fhir_resources`;
    const [governanceRow] = await sql`select count(*)::int as n from governance_proposal`;
    return {
      audit: Number(auditRow?.n ?? -1),
      fhir: Number(fhirRow?.n ?? -1),
      governance: Number(governanceRow?.n ?? -1)
    };
  });
  if (!result.ok) throw new Error(`footprint read failed: ${result.error.code}`);
  return result.data;
}

/** A valid synthetic Patient scribe input for propose_resource tests. */
export function syntheticPatient(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "http://example.org/synthetic/mrn", value: `mrn-${id.slice(0, 8)}` }],
    name: [{ family: "Synthetic", given: ["Casey"] }],
    gender: "female"
  };
}
