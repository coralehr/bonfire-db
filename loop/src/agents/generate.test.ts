import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { AgentDef } from "./agent-def.js";
import { generateFiles, renderClaudeAgent, renderCodexAgent } from "./generate.js";

const fixture: AgentDef = {
  name: "bonfire-maker",
  description: "Writes code inside the slice worktree.",
  claudeTools: ["Read", "Write", "Edit", "Grep", "Glob"],
  claudeModel: "inherit",
  codexReasoningEffort: "high",
  codexSandbox: "workspace-write",
  systemPrompt:
    "You are the maker.\n\n- Stay inside allowedPaths.\n- Emit a Result at the boundary."
};

const expectedClaude = `---
name: "bonfire-maker"
description: "Writes code inside the slice worktree."
tools: Read, Write, Edit, Grep, Glob
model: "inherit"
---

You are the maker.

- Stay inside allowedPaths.
- Emit a Result at the boundary.
`;

const expectedCodex = `name = "bonfire-maker"
description = "Writes code inside the slice worktree."
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"

developer_instructions = """
You are the maker.

- Stay inside allowedPaths.
- Emit a Result at the boundary.
"""
`;

describe("renderClaudeAgent / renderCodexAgent — exact byte-shapes", () => {
  test("renders the Claude `.md` format verbatim", () => {
    expect(renderClaudeAgent(fixture)).toBe(expectedClaude);
  });

  test("renders the Codex `.toml` format verbatim", () => {
    expect(renderCodexAgent(fixture)).toBe(expectedCodex);
  });

  test("escapes a backslash for the TOML multi-line string", () => {
    const withBackslash: AgentDef = { ...fixture, systemPrompt: "match /^BF-\\d{2}$/ now" };
    expect(renderCodexAgent(withBackslash)).toContain("match /^BF-\\\\d{2}$/ now");
  });

  test("read-only role joins its tools and emits the read-only sandbox", () => {
    const verifier: AgentDef = {
      ...fixture,
      name: "bonfire-verifier",
      claudeTools: ["Read", "Grep", "Glob"],
      codexSandbox: "read-only"
    };
    expect(renderClaudeAgent(verifier)).toContain("tools: Read, Grep, Glob");
    expect(renderCodexAgent(verifier)).toContain('sandbox_mode = "read-only"');
  });
});

describe("generateFiles — both targets, deterministic order", () => {
  test("emits .claude/.md and .codex/.toml per def, name-sorted", () => {
    const planner: AgentDef = { ...fixture, name: "bonfire-planner" };
    const files = generateFiles([fixture, planner]);
    expect(files.map((file) => file.path)).toEqual([
      ".claude/agents/bonfire-maker.md",
      ".codex/agents/bonfire-maker.toml",
      ".claude/agents/bonfire-planner.md",
      ".codex/agents/bonfire-planner.toml"
    ]);
    expect(files[0]?.content).toBe(expectedClaude);
    expect(files[1]?.content).toBe(expectedCodex);
  });

  test("order is independent of input order (stable sort by name)", () => {
    const planner: AgentDef = { ...fixture, name: "bonfire-planner" };
    const a = generateFiles([fixture, planner]).map((file) => file.path);
    const b = generateFiles([planner, fixture]).map((file) => file.path);
    expect(a).toEqual(b);
  });
});

describe("generated output is valid + round-trips through real parsers", () => {
  function frontmatter(md: string): string {
    // md is "---\n<frontmatter>\n---\n\n<body>"; take the block between the first two ---.
    return md.split("---\n")[1] ?? "";
  }

  test("Claude frontmatter is valid YAML and fields round-trip", () => {
    const fm = parseYaml(frontmatter(renderClaudeAgent(fixture))) as Record<string, unknown>;
    expect(fm.name).toBe(fixture.name);
    expect(fm.description).toBe(fixture.description);
    expect(fm.model).toBe(fixture.claudeModel);
  });

  test("a description with ': ' and '#' stays valid YAML (P1 regression)", () => {
    const tricky: AgentDef = {
      ...fixture,
      description: "Audits product slices: hunts leaks # not a comment"
    };
    const fm = parseYaml(frontmatter(renderClaudeAgent(tricky))) as Record<string, unknown>;
    expect(fm.description).toBe(tricky.description);
  });

  test("Codex output is valid TOML and developer_instructions round-trips", () => {
    const toml = parseToml(renderCodexAgent(fixture)) as Record<string, unknown>;
    expect(toml.name).toBe(fixture.name);
    expect(toml.sandbox_mode).toBe(fixture.codexSandbox);
    expect(String(toml.developer_instructions).trimEnd()).toBe(fixture.systemPrompt.trimEnd());
  });

  test("a backslash + quotes in the prompt round-trip through a TOML parser", () => {
    const tricky: AgentDef = { ...fixture, systemPrompt: 'path /^BF-\\d{2}$/ and a "quote" here' };
    const toml = parseToml(renderCodexAgent(tricky)) as Record<string, unknown>;
    expect(String(toml.developer_instructions).trimEnd()).toBe(tricky.systemPrompt.trimEnd());
  });
});
