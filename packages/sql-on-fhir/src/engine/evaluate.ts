/**
 * `evaluateView` — the ONE pure projection engine. Both the in-memory HL7
 * conformance runner and the Postgres vd_* materializer call this function,
 * so a conformance pass is evidence about the exact code that writes rows.
 */
import type { JsonObject, Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { ViewError } from "../errors.js";
import type { PathEnv } from "../fhirpath-eval.js";
import { checkPath, constantEnvValue, evaluateValues, rootContext } from "../fhirpath-eval.js";
import type { SelectNode, ViewDefinition } from "../view-definition.js";
import { constantValue, viewColumns } from "../view-definition.js";
import type { EvalScope, Row } from "./selection.js";
import { crossProduct, selectNodeRows } from "./selection.js";

function nodePaths(node: SelectNode): string[] {
  return [
    ...(node.forEach === undefined ? [] : [node.forEach]),
    ...(node.forEachOrNull === undefined ? [] : [node.forEachOrNull]),
    ...(node.repeat ?? []),
    ...(node.column ?? []).map((column) => column.path),
    ...(node.select ?? []).flatMap(nodePaths),
    ...(node.unionAll ?? []).flatMap(nodePaths)
  ];
}

function buildConstants(view: ViewDefinition): PathEnv {
  const constants: Record<string, unknown> = {};
  for (const constant of view.constant ?? []) {
    const { kind, value } = constantValue(constant);
    constants[constant.name] = constantEnvValue(kind, value);
  }
  return constants;
}

/**
 * Static checks that must fail even when zero resources match: every FHIRPath
 * expression parses and every unionAll branch set is column-compatible.
 * Returns the view's ordered output column names.
 */
export function validateView(view: ViewDefinition): Result<string[], ViewError> {
  const paths = [
    ...view.select.flatMap(nodePaths),
    ...(view.where ?? []).map((clause) => clause.path)
  ];
  for (const path of paths) {
    const parsed = checkPath(path);
    if (!parsed.ok) return parsed;
  }
  const columns = viewColumns(view);
  if (!columns.ok) return columns;
  return ok(columns.data.map((column) => column.name));
}

function whereKeepsResource(
  view: ViewDefinition,
  resource: JsonObject,
  scope: EvalScope
): Result<boolean, ViewError> {
  for (const clause of view.where ?? []) {
    const values = evaluateValues(rootContext(resource), clause.path, {
      ...scope.constants,
      rowIndex: 0
    });
    if (!values.ok) return values;
    if (values.data.length === 0) return ok(false);
    const verdict = values.data[0];
    if (values.data.length > 1 || typeof verdict !== "boolean") {
      return err({
        code: "VD_WHERE_NOT_BOOLEAN",
        message: `where path '${clause.path}' did not resolve to a single boolean`
      });
    }
    if (!verdict) return ok(false);
  }
  return ok(true);
}

function orderRow(row: Row, columns: readonly string[]): Row {
  const ordered: Row = {};
  for (const name of columns) ordered[name] = row[name] ?? null;
  return ordered;
}

/**
 * Evaluate a validated ViewDefinition against ONE canonical FHIR resource.
 * Resources whose resourceType differs from `view.resource`, or that any
 * `where` clause filters out, produce zero rows.
 */
export function evaluateView(view: ViewDefinition, resource: JsonObject): Result<Row[], ViewError> {
  const columns = validateView(view);
  if (!columns.ok) return columns;
  if (resource.resourceType !== view.resource) return ok([]);
  const scope: EvalScope = { constants: buildConstants(view) };
  const keep = whereKeepsResource(view, resource, scope);
  if (!keep.ok) return keep;
  if (!keep.data) return ok([]);
  const factors: Row[][] = [];
  for (const node of view.select) {
    const rows = selectNodeRows(node, rootContext(resource), scope, 0);
    if (!rows.ok) return rows;
    factors.push([...rows.data]);
  }
  return ok(crossProduct(factors).map((row) => orderRow(row, columns.data)));
}
