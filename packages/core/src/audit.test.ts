import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppendOnlyAuditLedger,
  BonfireAuditMutationDenied,
  verifyAuditHashChain,
  type AuditEvent
} from "./index";

const migrationSql = readFileSync(join(process.cwd(), "drizzle/0001_bf03_audit_append_only.sql"), "utf8");

function appendDemoEvents(): readonly AuditEvent[] {
  const audit = new AppendOnlyAuditLedger();
  audit.append({
    practiceId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222201",
    action: "patient.read",
    targetType: "patient",
    targetId: "33333333-3333-4333-8333-333333333301",
    decision: "allow",
    reason: "all_policy_checks_passed"
  }, {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    createdAt: "2026-01-05T00:00:00.000Z"
  });
  audit.append({
    practiceId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222202",
    action: "patient.read",
    targetType: "patient",
    targetId: "33333333-3333-4333-8333-333333333302",
    decision: "deny",
    reason: "policy_denied:clinician_role"
  }, {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    createdAt: "2026-01-05T00:01:00.000Z"
  });

  return audit.list();
}

describe("audit append-only ledger", () => {
  test("appends allow and deny events into a valid hash chain", () => {
    const events = appendDemoEvents();

    expect(events).toHaveLength(2);
    expect(events[0]?.decision).toBe("allow");
    expect(events[1]?.decision).toBe("deny");
    expect(events[1]?.prevHash).toBe(events[0]?.rowHash);
    expect(verifyAuditHashChain(events)).toEqual({ valid: true });
  });

  test("rejects update and delete attempts", () => {
    const audit = new AppendOnlyAuditLedger(appendDemoEvents());

    expect(() => audit.update("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", { reason: "changed" }))
      .toThrow(BonfireAuditMutationDenied);
    expect(() => audit.delete("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"))
      .toThrow(BonfireAuditMutationDenied);
  });

  test("stores immutable audit payload snapshots", () => {
    const audit = new AppendOnlyAuditLedger();
    const receipt = { reason: { code: "all_policy_checks_passed" } };

    audit.append({
      practiceId: "11111111-1111-4111-8111-111111111111",
      actorId: "22222222-2222-4222-8222-222222222201",
      action: "patient.read",
      targetType: "patient",
      targetId: "33333333-3333-4333-8333-333333333301",
      decision: "allow",
      reason: "all_policy_checks_passed",
      receipt
    }, {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      createdAt: "2026-01-05T00:02:00.000Z"
    });

    receipt.reason.code = "tampered";
    const returned = audit.list()[0] as AuditEvent & { receipt: { reason: { code: string } } };
    returned.receipt.reason.code = "tampered-again";

    expect((audit.list()[0] as AuditEvent & { receipt: { reason: { code: string } } }).receipt.reason.code)
      .toBe("all_policy_checks_passed");
    expect(verifyAuditHashChain(audit.list())).toEqual({ valid: true });
  });

  test("hash-chain verifier detects tampering", () => {
    const events = appendDemoEvents();
    const tampered = events.map((event) => ({ ...event }));
    tampered[0] = {
      ...tampered[0]!,
      reason: "changed after append"
    };

    expect(verifyAuditHashChain(tampered)).toMatchObject({
      valid: false,
      index: 0,
      reason: "row_hash_mismatch"
    });
  });

  test("migration blocks audit_events UPDATE and DELETE", () => {
    expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION bonfire_block_audit_events_mutation");
    expect(migrationSql).toContain("BEFORE UPDATE ON audit_events");
    expect(migrationSql).toContain("BEFORE DELETE ON audit_events");
    expect(migrationSql).toContain("audit_events is append-only");
  });
});
