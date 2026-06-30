/**
 * The slice registry: the validated, in-repo catalogue of BF-01..BF-13.
 *
 * The registry data is human-authored in `./tasks` (loop-harness-plan.md H1: no
 * prose auto-parsing of work boundaries). This module is the gatekeeper around it:
 * every entry is parsed with `sliceContractSchema`, ids must be unique and cover
 * exactly BF-01..BF-13, every `dependsOn` must resolve, and the dependency graph
 * must be acyclic. `validateEntries` is the pure validator (testable with fixtures);
 * `validateRegistry` runs it over the real `./tasks`. Accessors throw only on a
 * malformed in-repo registry (programmer error).
 */
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import type { SliceContract } from "./slice-contract.js";
import { sliceContractSchema } from "./slice-contract.js";
import { tasks } from "./tasks.js";

const EXPECTED_SLICE_COUNT = 13;
const SLICE_ID_PAD = 2;

/** A single registry problem, tagged by `code` so callers branch on the code. */
export interface RegistryIssue {
  readonly code:
    | "invalid-contract"
    | "duplicate-id"
    | "unexpected-id"
    | "missing-id"
    | "unknown-dependency"
    | "dependency-cycle";
  readonly message: string;
}

/** The success payload of `validateEntries`: the parsed, validated slices. */
export interface RegistryValidation {
  readonly slices: readonly SliceContract[];
}

/** The failure payload of `validateEntries`: every problem found, at once. */
export interface RegistryFailure {
  readonly issues: readonly RegistryIssue[];
}

function expectedIds(): readonly string[] {
  return Array.from(
    { length: EXPECTED_SLICE_COUNT },
    (_unused, index) => `BF-${String(index + 1).padStart(SLICE_ID_PAD, "0")}`
  );
}

function parseEntries(entries: readonly unknown[]): {
  readonly slices: SliceContract[];
  readonly issues: RegistryIssue[];
} {
  const slices: SliceContract[] = [];
  const issues: RegistryIssue[] = [];
  let index = 0;
  for (const entry of entries) {
    const parsed = sliceContractSchema.safeParse(entry);
    if (parsed.success) {
      slices.push(parsed.data);
    } else {
      const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
      issues.push({ code: "invalid-contract", message: `tasks[${String(index)}]: ${detail}` });
    }
    index += 1;
  }
  return { slices, issues };
}

function checkUniqueIds(slices: readonly SliceContract[]): readonly RegistryIssue[] {
  const seen = new Set<string>();
  const issues: RegistryIssue[] = [];
  for (const slice of slices) {
    if (seen.has(slice.id)) {
      issues.push({ code: "duplicate-id", message: `duplicate slice id ${slice.id}` });
    }
    seen.add(slice.id);
  }
  return issues;
}

function checkExpectedIds(slices: readonly SliceContract[]): readonly RegistryIssue[] {
  const present = new Set(slices.map((slice) => slice.id));
  const expected = new Set(expectedIds());
  const issues: RegistryIssue[] = [];
  for (const id of present) {
    if (!expected.has(id)) {
      issues.push({ code: "unexpected-id", message: `unexpected slice id ${id}` });
    }
  }
  for (const id of expected) {
    if (!present.has(id)) {
      issues.push({ code: "missing-id", message: `missing required slice id ${id}` });
    }
  }
  return issues;
}

function visit(
  id: string,
  graph: ReadonlyMap<string, readonly string[]>,
  visited: Set<string>,
  stack: Set<string>
): readonly string[] | undefined {
  if (visited.has(id)) {
    return undefined;
  }
  stack.add(id);
  for (const dep of graph.get(id) ?? []) {
    if (stack.has(dep)) {
      return [id, dep];
    }
    const cycle = visit(dep, graph, visited, stack);
    if (cycle !== undefined) {
      return [id, ...cycle];
    }
  }
  stack.delete(id);
  visited.add(id);
  return undefined;
}

function detectCycle(slices: readonly SliceContract[]): readonly RegistryIssue[] {
  const graph = new Map<string, readonly string[]>();
  for (const slice of slices) {
    graph.set(slice.id, slice.dependsOn);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  for (const slice of slices) {
    const cycle = visit(slice.id, graph, visited, stack);
    if (cycle !== undefined) {
      return [{ code: "dependency-cycle", message: `dependency cycle: ${cycle.join(" -> ")}` }];
    }
  }
  return [];
}

function checkDependencies(slices: readonly SliceContract[]): readonly RegistryIssue[] {
  const ids = new Set(slices.map((slice) => slice.id));
  const issues: RegistryIssue[] = [];
  for (const slice of slices) {
    for (const dep of slice.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({
          code: "unknown-dependency",
          message: `slice ${slice.id} depends on unknown slice ${dep}`
        });
      }
    }
  }
  // A broken edge set makes cycle detection meaningless; report edges first.
  return issues.length > 0 ? issues : detectCycle(slices);
}

/**
 * Pure registry validator: parse + check arbitrary entries, collecting every
 * problem in one pass. Never throws. Exported so the failure branches (duplicate /
 * missing / unexpected id, unknown dependency, cycle, invalid contract) are
 * directly testable with fixtures rather than only against the real `./tasks`.
 */
export function validateEntries(
  entries: readonly unknown[]
): Result<RegistryValidation, RegistryFailure> {
  const { slices, issues } = parseEntries(entries);
  const allIssues = [
    ...issues,
    ...checkUniqueIds(slices),
    ...checkExpectedIds(slices),
    ...checkDependencies(slices)
  ];
  if (allIssues.length > 0) {
    return err({ issues: allIssues });
  }
  return ok({ slices });
}

/** Validate the real in-repo registry (`./tasks`). Never throws. */
export function validateRegistry(): Result<RegistryValidation, RegistryFailure> {
  return validateEntries(tasks);
}

let cache: readonly SliceContract[] | undefined;

function loadRegistry(): readonly SliceContract[] {
  if (cache !== undefined) {
    return cache;
  }
  const result = validateRegistry();
  if (!result.ok) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid slice registry: ${detail}`);
  }
  cache = result.value.slices;
  return cache;
}

/** Every validated slice, in registry order. Throws on a malformed registry. */
export function allSlices(): readonly SliceContract[] {
  return loadRegistry();
}

/** Look up a slice by id, or `undefined` if no such slice exists. */
export function getSlice(id: string): SliceContract | undefined {
  return loadRegistry().find((slice) => slice.id === id);
}
