import { describe, expect, test } from "bun:test";
import { agentDefSchema } from "./agent-def.js";

function validDef(): Record<string, unknown> {
  return {
    name: "bonfire-maker",
    description: "Writes code inside the slice worktree.",
    claudeTools: ["Read", "Write", "Edit", "Grep", "Glob"],
    claudeModel: "inherit",
    codexReasoningEffort: "high",
    codexSandbox: "workspace-write",
    systemPrompt: "You are the maker."
  };
}

function accepts(value: unknown): boolean {
  return agentDefSchema.safeParse(value).success;
}

describe("agentDefSchema — accept", () => {
  test("accepts a well-formed def", () => {
    expect(accepts(validDef())).toBe(true);
  });

  test("accepts the read-only sandbox", () => {
    expect(accepts({ ...validDef(), codexSandbox: "read-only" })).toBe(true);
  });
});

describe("agentDefSchema — reject", () => {
  test("rejects a name without the bonfire- prefix", () => {
    expect(accepts({ ...validDef(), name: "maker" })).toBe(false);
  });

  test("rejects a name with uppercase letters", () => {
    expect(accepts({ ...validDef(), name: "bonfire-Maker" })).toBe(false);
  });

  test("rejects an empty tools array", () => {
    expect(accepts({ ...validDef(), claudeTools: [] })).toBe(false);
  });

  test("rejects an empty tool string", () => {
    expect(accepts({ ...validDef(), claudeTools: ["Read", ""] })).toBe(false);
  });

  test("rejects an unknown sandbox value", () => {
    expect(accepts({ ...validDef(), codexSandbox: "full-access" })).toBe(false);
  });

  test("rejects a TOML triple-double-quote in the system prompt", () => {
    expect(accepts({ ...validDef(), systemPrompt: 'has """ inside' })).toBe(false);
  });

  test("rejects an empty system prompt", () => {
    expect(accepts({ ...validDef(), systemPrompt: "" })).toBe(false);
  });

  test("rejects a multi-line description", () => {
    expect(accepts({ ...validDef(), description: "line one\nline two" })).toBe(false);
  });

  test("rejects an unknown extra key (strict object)", () => {
    expect(accepts({ ...validDef(), extra: true })).toBe(false);
  });
});
