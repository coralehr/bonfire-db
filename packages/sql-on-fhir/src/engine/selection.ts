/**
 * Select-tree evaluation: forEach / forEachOrNull / repeat iteration, nested
 * select cross-products, unionAll concatenation, and the ordered column list
 * (with unionAll branch column-set equality enforced).
 */
import type { JsonValue, Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { ViewError } from "../errors.js";
import type { PathContext, PathEnv } from "../fhirpath-eval.js";
import { emptyContext, evaluateNodes, evaluateValues } from "../fhirpath-eval.js";
import type { SelectNode, ViewColumn } from "../view-definition.js";
import { scalarizeColumn } from "./scalarize.js";

export type Row = Record<string, JsonValue>;

/** Constants shared by every evaluation in one view run. */
export interface EvalScope {
  readonly constants: PathEnv;
}

const MAX_REPEAT_DEPTH = 64;

function envWithRowIndex(scope: EvalScope, rowIndex: number): PathEnv {
  return { ...scope.constants, rowIndex };
}

interface IterationItem {
  readonly context: PathContext;
  readonly rowIndex: number;
}

function walkRepeat(
  paths: readonly string[],
  context: PathContext,
  env: PathEnv,
  out: PathContext[],
  depth: number
): ViewError | undefined {
  if (depth > MAX_REPEAT_DEPTH) {
    return { code: "VD_REPEAT_DEPTH_EXCEEDED", message: "repeat traversal exceeded max depth" };
  }
  for (const path of paths) {
    const children = evaluateNodes(context, path, env);
    if (!children.ok) return children.error;
    for (const child of children.data) {
      out.push(child);
      const failure = walkRepeat(paths, child, env, out, depth + 1);
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}

/**
 * Resolve the contexts a node iterates over; `undefined` means the node does
 * not iterate (evaluate its body once against the incoming context, index 0).
 */
function resolveIteration(
  node: SelectNode,
  context: PathContext,
  scope: EvalScope,
  inheritedRowIndex: number
): Result<IterationItem[] | undefined, ViewError> {
  const env = envWithRowIndex(scope, inheritedRowIndex);
  if (node.forEach !== undefined || node.forEachOrNull !== undefined) {
    const path = node.forEach ?? node.forEachOrNull ?? "";
    const nodes = evaluateNodes(context, path, env);
    if (!nodes.ok) return nodes;
    if (nodes.data.length === 0 && node.forEachOrNull !== undefined) {
      return ok([{ context: emptyContext(), rowIndex: 0 }]);
    }
    return ok(nodes.data.map((item, index) => ({ context: item, rowIndex: index })));
  }
  if (node.repeat !== undefined) {
    const collected: PathContext[] = [];
    const failure = walkRepeat(node.repeat, context, env, collected, 0);
    if (failure !== undefined) return err(failure);
    return ok(collected.map((item, index) => ({ context: item, rowIndex: index })));
  }
  return ok(undefined);
}

function columnsRow(
  columns: readonly ViewColumn[],
  context: PathContext,
  env: PathEnv
): Result<Row, ViewError> {
  const row: Row = {};
  for (const column of columns) {
    const values = evaluateValues(context, column.path, env);
    if (!values.ok) return values;
    const scalar = scalarizeColumn(column, values.data);
    if (!scalar.ok) return scalar;
    row[column.name] = scalar.data;
  }
  return ok(row);
}

/** Combine independent row sets; ANY empty factor collapses to zero rows. */
export function crossProduct(factors: readonly (readonly Row[])[]): Row[] {
  let combined: Row[] = [{}];
  for (const factor of factors) {
    if (factor.length === 0) return [];
    const next: Row[] = [];
    for (const left of combined) {
      for (const right of factor) next.push({ ...left, ...right });
    }
    combined = next;
  }
  return combined;
}

function unionRows(
  branches: readonly SelectNode[],
  context: PathContext,
  scope: EvalScope,
  inheritedRowIndex: number
): Result<Row[], ViewError> {
  const rows: Row[] = [];
  for (const branch of branches) {
    const branchRows = selectNodeRows(branch, context, scope, inheritedRowIndex);
    if (!branchRows.ok) return branchRows;
    rows.push(...branchRows.data);
  }
  return ok(rows);
}

function nodeBodyRows(
  node: SelectNode,
  context: PathContext,
  rowIndex: number,
  scope: EvalScope
): Result<Row[], ViewError> {
  const factors: Row[][] = [];
  const own = columnsRow(node.column ?? [], context, envWithRowIndex(scope, rowIndex));
  if (!own.ok) return own;
  factors.push([own.data]);
  for (const child of node.select ?? []) {
    const childRows = selectNodeRows(child, context, scope, rowIndex);
    if (!childRows.ok) return childRows;
    factors.push([...childRows.data]);
  }
  if (node.unionAll !== undefined) {
    const unioned = unionRows(node.unionAll, context, scope, rowIndex);
    if (!unioned.ok) return unioned;
    factors.push([...unioned.data]);
  }
  return ok(crossProduct(factors));
}

/**
 * Evaluate one select node against a context, honoring its iteration mode.
 * A node that iterates (forEach / forEachOrNull / repeat) binds %rowIndex to
 * its own 0-based iteration position; a non-iterating node INHERITS the
 * enclosing row index (0 at the resource root) — pinned by the suite's
 * "%rowIndex in unionAll inside forEach" case.
 */
export function selectNodeRows(
  node: SelectNode,
  context: PathContext,
  scope: EvalScope,
  inheritedRowIndex: number
): Result<Row[], ViewError> {
  const iteration = resolveIteration(node, context, scope, inheritedRowIndex);
  if (!iteration.ok) return iteration;
  if (iteration.data === undefined) {
    return nodeBodyRows(node, context, inheritedRowIndex, scope);
  }
  const rows: Row[] = [];
  for (const item of iteration.data) {
    const bodyRows = nodeBodyRows(node, item.context, item.rowIndex, scope);
    if (!bodyRows.ok) return bodyRows;
    rows.push(...bodyRows.data);
  }
  return ok(rows);
}
