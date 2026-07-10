/**
 * Deterministic SDK codegen: renders src/generated/client.gen.ts from the OPS
 * IR (src/ir.ts). No timestamps, entries sorted by method name, LF newlines —
 * rerunning is byte-identical, which the gate pins with
 * `bun run --filter @bonfire/sdk gen && git diff --exit-code`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { OpSpec } from "../ir.js";
import { OPS } from "../ir.js";

const OUT_DIR = new URL("../generated/", import.meta.url);
const OUT_FILE = new URL("client.gen.ts", OUT_DIR);

/** Locale-independent name ordering keeps the output byte-deterministic. */
function byMethod(a: OpSpec, b: OpSpec): number {
  return a.method < b.method ? -1 : 1;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : 1;
}

function interfaceMember(op: OpSpec): string {
  return `  /** ${op.doc} */\n  ${op.method}(input: ${op.inputType}): Promise<${op.resultType}>;`;
}

function factoryMember(op: OpSpec): string {
  return `    ${op.method}: (input: ${op.inputType}): Promise<${op.resultType}> =>\n      runOp(db, session, ${op.adapter}, input)`;
}

function render(ops: readonly OpSpec[]): string {
  const typeNames = ops.flatMap((op) => [op.inputType, op.resultType]).sort(byName);
  const adapters = ops.map((op) => op.adapter).sort(byName);
  return [
    "/**",
    " * GENERATED FILE — do not edit by hand.",
    " * Rendered by `bun run --filter @bonfire/sdk gen` from src/ir.ts;",
    " * the gate re-runs the generator and fails on any drift.",
    " */",
    'import type { TenantDb } from "@bonfire/core";',
    'import type { BonfireSession } from "../auth/session.js";',
    "import type {",
    typeNames.map((name) => `  ${name}`).join(",\n"),
    '} from "../ops.js";',
    `import { ${adapters.join(", ")} } from "../ops.js";`,
    'import { runOp } from "../run-op.js";',
    "",
    "/** One typed method per mirrored public operation; every method returns a Result. */",
    "export interface BonfireClient {",
    ops.map(interfaceMember).join("\n"),
    "}",
    "",
    "/** Bind a session to the ONE runOp executor behind the generated surface. */",
    "export function createBonfireClient(db: TenantDb, session: BonfireSession): BonfireClient {",
    "  return {",
    ops.map(factoryMember).join(",\n"),
    "  };",
    "}",
    ""
  ].join("\n");
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, render([...OPS].sort(byMethod)), "utf8");
}

main();
