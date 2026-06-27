/**
 * The agent definition: the SINGLE SOURCE OF TRUTH for one harness agent.
 *
 * Each loop agent (bonfire-maker, bonfire-verifier, bonfire-security-auditor,
 * bonfire-planner) is authored once as an `AgentDef`. The generator
 * (./generate.ts) renders that one value into BOTH editor formats Claude Code
 * (`.claude/agents/<name>.md`) and Codex (`.codex/agents/<name>.toml`) actually
 * read, so the two can never drift (loop-harness-plan.md H2).
 *
 * The schema is the boundary: every field is parsed, not trusted. Notable
 * guards — `name` is a kebab `bonfire-*` slug (safe in a filename, YAML scalar,
 * and TOML key), `description` is single-line (a newline would break the YAML
 * frontmatter and the TOML single-line string), and `systemPrompt` must not
 * contain a TOML triple-double-quote (which would terminate the `"""` block the
 * Codex renderer embeds it in).
 */
import { z } from "zod";

/** Agent name pattern: `bonfire-` followed by lowercase letters and hyphens. */
export const AGENT_NAME_PATTERN = /^bonfire-[a-z-]+$/;

const nonEmptyString = z.string().min(1);

const TOML_TRIPLE_QUOTE = '"""';

export const agentDefSchema = z.strictObject({
  name: z.string().regex(AGENT_NAME_PATTERN, "name must match /^bonfire-[a-z-]+$/"),
  description: nonEmptyString.refine(
    (value) => !/[\r\n]/.test(value),
    "description must be a single line (no newline)"
  ),
  claudeTools: z.array(nonEmptyString).min(1),
  claudeModel: nonEmptyString,
  codexReasoningEffort: nonEmptyString,
  codexSandbox: z.enum(["workspace-write", "read-only"]),
  systemPrompt: nonEmptyString.refine(
    (value) => !value.includes(TOML_TRIPLE_QUOTE),
    "systemPrompt must not contain a TOML triple-double-quote"
  )
});

/** A single agent's definition the generator renders into both editor formats. */
export type AgentDef = z.infer<typeof agentDefSchema>;
