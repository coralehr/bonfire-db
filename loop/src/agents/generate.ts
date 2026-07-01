/**
 * The single-source renderers: one `AgentDef` -> both editor formats.
 *
 * `renderClaudeAgent` emits the `.claude/agents/<name>.md` byte-shape (YAML
 * frontmatter + verbatim markdown body); `renderCodexAgent` emits the
 * `.codex/agents/<name>.toml` byte-shape (scalar keys + the system prompt inside
 * a TOML multi-line basic string). `generateFiles` pairs every def with its two
 * repo-root-relative output files in a deterministic order, so the drift check
 * (./drift.ts) and the writer (./write.ts) agree byte-for-byte. The TOML string
 * is escaped so an arbitrary (but triple-quote-free, per the schema) prompt
 * round-trips through a TOML parser unchanged.
 */
import type { AgentDef } from "./agent-def.js";

/** One generated file: a repo-root-relative path and its exact bytes. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

const HEX_RADIX = 16;
const UNICODE_ESCAPE_WIDTH = 4;
// C0 control range upper bound, the DEL code point, and the three controls TOML
// permits literally in a basic string (tab, line feed, carriage return).
const C0_CONTROL_MAX = 0x1f;
const DELETE_CODE = 0x7f;
const TAB_CODE = 0x09;
const LINE_FEED_CODE = 0x0a;
const CARRIAGE_RETURN_CODE = 0x0d;

// TOML basic strings forbid the backslash and control characters other than
// tab, line feed, and carriage return; those must be escaped or the document is
// invalid. `"` is left literal in the multi-line block (only `"""` would close
// it, and the schema rejects a prompt containing it).
function isDisallowedTomlControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code === TAB_CODE || code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE) {
    return false;
  }
  return code <= C0_CONTROL_MAX || code === DELETE_CODE;
}

function escapeControl(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return `\\u${code.toString(HEX_RADIX).toUpperCase().padStart(UNICODE_ESCAPE_WIDTH, "0")}`;
}

/** Escape a value for a TOML single-line basic string (`"..."`). */
function escapeTomlScalar(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (isDisallowedTomlControl(ch)) {
      out += escapeControl(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape a value for a TOML multi-line basic string (`"""..."""`). */
function escapeTomlMultiline(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (isDisallowedTomlControl(ch)) {
      out += escapeControl(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Render the Claude Code agent file (`.claude/agents/<name>.md`). */
export function renderClaudeAgent(def: AgentDef): string {
  return (
    [
      "---",
      // JSON.stringify yields a valid YAML double-quoted flow scalar, so any
      // single-line value (e.g. a description containing ": ") keeps the
      // frontmatter parseable. tools stays an unquoted comma list by convention.
      `name: ${JSON.stringify(def.name)}`,
      `description: ${JSON.stringify(def.description)}`,
      `tools: ${def.claudeTools.join(", ")}`,
      `model: ${JSON.stringify(def.claudeModel)}`,
      "---",
      "",
      def.systemPrompt
    ].join("\n") + "\n"
  );
}

/** Render the Codex agent file (`.codex/agents/<name>.toml`). */
export function renderCodexAgent(def: AgentDef): string {
  return (
    [
      `name = "${escapeTomlScalar(def.name)}"`,
      `description = "${escapeTomlScalar(def.description)}"`,
      `model_reasoning_effort = "${escapeTomlScalar(def.codexReasoningEffort)}"`,
      `sandbox_mode = "${escapeTomlScalar(def.codexSandbox)}"`,
      "",
      'developer_instructions = """',
      escapeTomlMultiline(def.systemPrompt),
      '"""'
    ].join("\n") + "\n"
  );
}

/**
 * Render every def into its two output files, in a deterministic, name-sorted
 * order so the drift check and the writer produce identical, stable output.
 */
export function generateFiles(defs: readonly AgentDef[]): GeneratedFile[] {
  const sorted = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: GeneratedFile[] = [];
  for (const def of sorted) {
    files.push({ path: `.claude/agents/${def.name}.md`, content: renderClaudeAgent(def) });
    files.push({ path: `.codex/agents/${def.name}.toml`, content: renderCodexAgent(def) });
  }
  return files;
}
