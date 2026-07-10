/**
 * U1/U4 allowlist battery (dangerChecks: propose-only-broken, fail-open-authz,
 * cross-tenant-leak). Pins the EXACT three-tool surface (names + strict input
 * schemas), proves unlisted tools and off-schema arguments are denied with
 * ZERO side effects (per-practice audit/fhir row counts as the execution
 * oracle, with a positive control proving the oracle is live), proves the
 * agent path cannot cross tenants, and proves get_context emits the CCP text
 * VERBATIM. All data is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connectTenantDb } from "@bonfire/core";
import type { McpFixture, TenantFixture } from "./support.test.js";
import {
  connectMcp,
  newTenantSession,
  ownerSql,
  seedConditions,
  syntheticPatient,
  tenantFootprint
} from "./support.test.js";

const TERM = "mcptrace";
const db = connectTenantDb({ max: 4 });
const owner = ownerSql();

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let fxA: McpFixture;
let fxB: McpFixture;

beforeAll(async () => {
  [tenantA, tenantB] = await Promise.all([
    newTenantSession(db, owner, "clinician"),
    newTenantSession(db, owner, "clinician")
  ]);
  await seedConditions(db, tenantA.practiceId, [`${TERM} chronic sinusitis`]);
  [fxA, fxB] = await Promise.all([
    connectMcp(db, tenantA.session),
    connectMcp(db, tenantB.session)
  ]);
});

afterAll(async () => {
  await fxA.close();
  await fxB.close();
  await Promise.all([db.end(), owner.end()]);
});

describe("tools/list (U1: the fixed propose-only surface)", () => {
  test("exactly three tools, strict schemas, no raw-power or governance tool", async () => {
    const listed = await fxA.caller.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["get_context", "propose_resource", "search_clinical"]);
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(/approve|commit|sql|shell|fhirpath|exec|file/i.test(tool.name)).toBe(false);
    }
    const properties = new Map(
      listed.tools.map((tool) => [
        tool.name,
        Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).sort()
      ])
    );
    expect(properties.get("search_clinical")).toEqual(["query", "topN"]);
    expect(properties.get("get_context")).toEqual(["query", "topN"]);
    expect(properties.get("propose_resource")).toEqual(["resource"]);
    // No identity/scope knob is caller-writable on ANY tool schema.
    for (const keys of properties.values()) {
      for (const key of keys) {
        expect(/subject|practice|role|actor|iss|sub$/i.test(key)).toBe(false);
      }
    }
  });

  test("unlisted tool names are denied with ZERO side effects", async () => {
    const before = await tenantFootprint(db, tenantA.practiceId);
    for (const name of ["approve_resource", "commit_resource", "sql", "read_file"]) {
      const denied = await fxA.caller.callTool({ name, arguments: {} });
      expect(denied.isError).toBe(true);
    }
    expect(await tenantFootprint(db, tenantA.practiceId)).toEqual(before);
  });

  test("off-schema arguments are denied pre-handler; a valid call audits (live oracle)", async () => {
    const before = await tenantFootprint(db, tenantA.practiceId);
    const extraKey = await fxA.caller.callTool({
      name: "search_clinical",
      arguments: { query: TERM, practiceId: tenantB.practiceId }
    });
    expect(extraKey.isError).toBe(true);
    const wrongType = await fxA.caller.callTool({
      name: "search_clinical",
      arguments: { query: 42 }
    });
    expect(wrongType.isError).toBe(true);
    // Handler never ran: not even the mandatory audit-on-read row appeared.
    const mid = await tenantFootprint(db, tenantA.practiceId);
    expect(mid).toEqual(before);
    const valid = await fxA.caller.callTool({
      name: "search_clinical",
      arguments: { query: TERM }
    });
    expect(valid.isError).toBeFalsy();
    const after = await tenantFootprint(db, tenantA.practiceId);
    expect(after.audit).toBe(mid.audit + 1);
  });
});

interface SearchView {
  readonly results: unknown[];
  readonly policyReceipt: { practiceId: string; decision: string };
  readonly auditEventId: string;
}

/** Run the TERM search through one fixture; returns the typed view + text. */
async function searchVia(fx: McpFixture): Promise<{ view: SearchView; text: string }> {
  const found = await fx.caller.callTool({ name: "search_clinical", arguments: { query: TERM } });
  expect(found.isError).toBeFalsy();
  return {
    view: found.structuredContent as SearchView,
    text: (found.content as { text: string }[])[0]?.text ?? ""
  };
}

describe("tool calls (U4: session-bound, tenant-scoped, sanitized)", () => {
  test("search_clinical returns hits + receipt + audit id for the OWN practice", async () => {
    const { view } = await searchVia(fxA);
    expect(view.results.length).toBeGreaterThan(0);
    expect(view.policyReceipt.decision).toBe("allow");
    expect(view.policyReceipt.practiceId).toBe(tenantA.practiceId);
    expect(view.auditEventId).toHaveLength(64);
  });

  test("practice B calling search_clinical for A's term: deny/empty + receipt, zero rows", async () => {
    const { view, text } = await searchVia(fxB);
    expect(view.results).toHaveLength(0);
    expect(view.policyReceipt.practiceId).toBe(tenantB.practiceId);
    expect(view.auditEventId).toHaveLength(64);
    expect(text).toContain("search: 0 hit(s)");
  });

  test("get_context chains server-side and emits the CCP text VERBATIM", async () => {
    const built = await fxA.caller.callTool({
      name: "get_context",
      arguments: { query: TERM, topN: 5 }
    });
    expect(built.isError).toBeFalsy();
    const structured = built.structuredContent as {
      spans: { jsonPath: string; value: unknown }[];
      policyReceipt: { practiceId: string };
      sourceAuditEventId: string;
      text?: string;
    };
    const text = (built.content as { text: string }[])[0]?.text ?? "";
    // Byte-level pin: header line and every span line are the serializer's own
    // output — any re-serialization in the tool layer breaks these.
    expect(text.split("\n")[0]).toBe(
      `CCP v1 audit=${JSON.stringify(structured.sourceAuditEventId)}`
    );
    expect(structured.spans.length).toBeGreaterThan(0);
    for (const span of structured.spans) {
      expect(text).toContain(`  ${span.jsonPath}: ${JSON.stringify(span.value)}`);
    }
    expect(structured.policyReceipt.practiceId).toBe(tenantA.practiceId);
    // D7: the document text is emitted ONCE (content), never duplicated here.
    expect(structured.text).toBeUndefined();
  });

  test("propose_resource writes NOW into the session practice (honest propose)", async () => {
    const resourceId = randomUUID();
    const before = await tenantFootprint(db, tenantA.practiceId);
    const written = await fxA.caller.callTool({
      name: "propose_resource",
      arguments: { resource: syntheticPatient(resourceId) }
    });
    expect(written.isError).toBeFalsy();
    const structured = written.structuredContent as {
      resourceType: string;
      id: string;
      versionId: string;
    };
    expect(structured.resourceType).toBe("Patient");
    expect(structured.id).toBe(resourceId);
    expect(structured.versionId).toBe("1");
    const after = await tenantFootprint(db, tenantA.practiceId);
    expect(after.fhir).toBe(before.fhir + 1);
    const visible = await db.withTenant(tenantA.practiceId, (sql) => {
      return sql`select id from fhir_resources where id = ${resourceId}`;
    });
    if (!visible.ok) throw new Error(visible.error.code);
    expect(visible.data).toHaveLength(1);
  });

  test("a forced domain error surfaces the stable code and NONE of the raw message", async () => {
    const resourceId = randomUUID();
    const resource = syntheticPatient(resourceId);
    const first = await fxA.caller.callTool({ name: "propose_resource", arguments: { resource } });
    expect(first.isError).toBeFalsy();
    const duplicate = await fxA.caller.callTool({
      name: "propose_resource",
      arguments: { resource }
    });
    expect(duplicate.isError).toBe(true);
    const text = (duplicate.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("TENANT_TX_FAILED");
    expect(text).not.toContain("duplicate key");
    expect(text).not.toContain("fhir_resources_pkey");
    const structured = duplicate.structuredContent as { error: { code: string } };
    expect(structured.error.code).toBe("TENANT_TX_FAILED");
  });
});
