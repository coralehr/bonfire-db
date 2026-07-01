import { describe, expect, test } from "bun:test";
import { parseVerdict } from "./verdict.js";

const PASS_BLOCK = `Some preamble the verifier wrote.

VERDICT: PASS

BLOCKING
- none

NON-BLOCKING
- consider renaming db.ts

RUN THESE TO CONFIRM
- bun test packages/core

ACCEPTANCE TRACE
- health endpoint returns ok — PASS — apps/api/src/health.ts:12
- migrations apply cleanly — PASS — bun run db:migrate
`;

const FAIL_BLOCK = `VERDICT: FAIL

BLOCKING
1. RLS policy missing on audit table — packages/core/src/audit.ts:33 — add FORCE ROW LEVEL SECURITY

NON-BLOCKING
- none

RUN THESE TO CONFIRM
- bun run gate

ACCEPTANCE TRACE
- audit rows carry practice_id | FAIL | packages/core/src/audit.ts:33
`;

describe("parseVerdict — accepts well-formed blocks", () => {
  test("a PASS block parses with an all-PASS trace and empty blocking", () => {
    const r = parseVerdict(PASS_BLOCK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.verdict).toBe("PASS");
      expect(r.value.blocking).toEqual([]);
      expect(r.value.acceptanceTrace).toHaveLength(2);
      expect(r.value.acceptanceTrace[0]?.evidence).toBe("apps/api/src/health.ts:12");
    }
  });

  test("a FAIL block parses (numbered blocking, pipe-separated trace row)", () => {
    const r = parseVerdict(FAIL_BLOCK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.verdict).toBe("FAIL");
      expect(r.value.blocking).toHaveLength(1);
      expect(r.value.acceptanceTrace[0]?.status).toBe("FAIL");
    }
  });
});

describe("parseVerdict — fail-closed rejections", () => {
  test("a template echo (all three statuses) is unparseable", () => {
    const r = parseVerdict(
      PASS_BLOCK.replace("VERDICT: PASS", "VERDICT: PASS | FAIL | NEEDS-HUMAN")
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("VERDICT:");
  });

  test("a missing section is named in the issues", () => {
    const r = parseVerdict(PASS_BLOCK.replace("ACCEPTANCE TRACE", "TRACE"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("ACCEPTANCE TRACE");
  });

  test("an unparseable trace row (no status token) is rejected", () => {
    const r = parseVerdict(PASS_BLOCK.replace("— PASS — apps/api/src/health.ts:12", "looks fine"));
    expect(r.ok).toBe(false);
  });

  test("a PASS with a BLOCKING finding violates the cross-field rule", () => {
    const r = parseVerdict(PASS_BLOCK.replace("- none", "- something is broken"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("no BLOCKING");
  });

  test("a PASS with a FAIL acceptance row is rejected", () => {
    const r = parseVerdict(
      PASS_BLOCK.replace("migrations apply cleanly — PASS", "migrations apply cleanly — FAIL")
    );
    expect(r.ok).toBe(false);
  });

  test("a FAIL with empty BLOCKING is rejected (findings required)", () => {
    const r = parseVerdict(
      FAIL_BLOCK.replace(
        "1. RLS policy missing on audit table — packages/core/src/audit.ts:33 — add FORCE ROW LEVEL SECURITY",
        "- none"
      )
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("BLOCKING");
  });

  test("an empty acceptance trace is rejected (the trace is the core artifact)", () => {
    const gutted = PASS_BLOCK.split("ACCEPTANCE TRACE")[0] ?? "";
    const r = parseVerdict(`${gutted}ACCEPTANCE TRACE\n- none\n`);
    expect(r.ok).toBe(false);
  });

  test("free text is rejected outright", () => {
    expect(parseVerdict("looks good to me, ship it").ok).toBe(false);
  });
});
