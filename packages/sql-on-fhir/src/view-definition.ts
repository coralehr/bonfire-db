/**
 * SQL-on-FHIR v2 ViewDefinition boundary schemas (Zod 4, parse-don't-validate).
 *
 * Two tiers:
 *  - `viewDefinitionSchema`: the spec shape the HL7 conformance suite exercises
 *    (name optional; select/column/forEach/forEachOrNull/unionAll/repeat/where/
 *    constant).
 *  - `parseMaterializableView`: the stricter tier required to create a vd_*
 *    Postgres table (name required and SQL-safe, a top-level getResourceKey()
 *    column, no reserved column names, globally unique column names).
 */
import type { Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import { z } from "zod";
import type { ViewError } from "./errors.js";

export interface ViewColumn {
  readonly name: string;
  readonly path: string;
  readonly type?: string | undefined;
  readonly collection?: boolean | undefined;
}

export interface SelectNode {
  readonly column?: readonly ViewColumn[] | undefined;
  readonly select?: readonly SelectNode[] | undefined;
  readonly forEach?: string | undefined;
  readonly forEachOrNull?: string | undefined;
  readonly repeat?: readonly string[] | undefined;
  readonly unionAll?: readonly SelectNode[] | undefined;
}

const columnSchema: z.ZodType<ViewColumn> = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1).optional(),
  collection: z.boolean().optional()
});

const selectNodeSchema: z.ZodType<SelectNode> = z.lazy(() =>
  z.object({
    column: z.array(columnSchema).optional(),
    select: z.array(selectNodeSchema).optional(),
    forEach: z.string().min(1).optional(),
    forEachOrNull: z.string().min(1).optional(),
    repeat: z.array(z.string().min(1)).min(1).optional(),
    unionAll: z.array(selectNodeSchema).optional()
  })
);

const constantValueKinds = [
  "valueBase64Binary",
  "valueBoolean",
  "valueCanonical",
  "valueCode",
  "valueDate",
  "valueDateTime",
  "valueDecimal",
  "valueId",
  "valueInstant",
  "valueInteger",
  "valueOid",
  "valuePositiveInt",
  "valueString",
  "valueTime",
  "valueUnsignedInt",
  "valueUri",
  "valueUrl",
  "valueUuid"
] as const;

export type ConstantValueKind = (typeof constantValueKinds)[number];

const constantShape = z.object({
  name: z.string().min(1),
  valueBase64Binary: z.string().optional(),
  valueBoolean: z.boolean().optional(),
  valueCanonical: z.string().optional(),
  valueCode: z.string().optional(),
  valueDate: z.string().optional(),
  valueDateTime: z.string().optional(),
  valueDecimal: z.number().optional(),
  valueId: z.string().optional(),
  valueInstant: z.string().optional(),
  valueInteger: z.number().int().optional(),
  valueOid: z.string().optional(),
  valuePositiveInt: z.number().int().optional(),
  valueString: z.string().optional(),
  valueTime: z.string().optional(),
  valueUnsignedInt: z.number().int().optional(),
  valueUri: z.string().optional(),
  valueUrl: z.string().optional(),
  valueUuid: z.string().optional()
});

const constantSchema = constantShape.refine(
  (candidate) => constantValueKinds.filter((kind) => candidate[kind] !== undefined).length === 1,
  { message: "a ViewDefinition constant requires exactly one value[x]" }
);

export type ViewConstant = z.infer<typeof constantSchema>;

/** Resolve which value[x] a constant carries plus its raw value. */
export function constantValue(constant: ViewConstant): {
  readonly kind: ConstantValueKind;
  readonly value: string | number | boolean;
} {
  for (const kind of constantValueKinds) {
    const value = constant[kind];
    if (value !== undefined) return { kind, value };
  }
  // Unreachable by construction: the refine above guarantees exactly one.
  throw new Error("constant without a value[x] escaped schema validation");
}

export const viewDefinitionSchema = z.object({
  name: z.string().min(1).optional(),
  resource: z.string().min(1),
  status: z.string().optional(),
  description: z.string().optional(),
  constant: z.array(constantSchema).optional(),
  select: z.array(selectNodeSchema).min(1),
  where: z.array(z.object({ path: z.string().min(1) })).optional()
});

export type ViewDefinition = z.infer<typeof viewDefinitionSchema>;

/** Parse an untrusted ViewDefinition payload (spec tier). */
export function parseViewDefinition(input: unknown): Result<ViewDefinition, ViewError> {
  const parsed = viewDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "input" : issue.path.join(".") || "input";
    return err({ code: "VD_INVALID", message: `invalid ViewDefinition at ${where}` });
  }
  return ok(parsed.data);
}

/** Column names owned by the projection system, never by a ViewDefinition. */
export const RESERVED_COLUMN_NAMES: readonly string[] = [
  "practice_id",
  "row_index",
  "version_id",
  "last_updated"
];

const MATERIALIZABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,50}$/;

export interface MaterializableView {
  readonly view: ViewDefinition;
  readonly name: string;
  /** The top-level getResourceKey() column that becomes the vd_* key. */
  readonly keyColumn: string;
}

/**
 * Ordered columns of a select subtree (column, then nested selects, then
 * unionAll), validating that every unionAll branch exposes an identical
 * ordered column-name list. unionAll branches contribute ONE shared column
 * set (the first branch), mirroring SQL UNION ALL semantics.
 */
function nodeColumns(node: SelectNode): Result<ViewColumn[], ViewError> {
  const columns = [...(node.column ?? [])];
  for (const child of node.select ?? []) {
    const childColumns = nodeColumns(child);
    if (!childColumns.ok) return childColumns;
    columns.push(...childColumns.data);
  }
  if (node.unionAll !== undefined && node.unionAll.length > 0) {
    const branchLists: ViewColumn[][] = [];
    for (const branch of node.unionAll) {
      const branchColumns = nodeColumns(branch);
      if (!branchColumns.ok) return branchColumns;
      branchLists.push(branchColumns.data);
    }
    const first = branchLists[0] ?? [];
    const mismatched = branchLists.some(
      (list) => list.length !== first.length || list.some((col, i) => col.name !== first[i]?.name)
    );
    if (mismatched) {
      return err({
        code: "VD_UNION_COLUMN_MISMATCH",
        message: "unionAll branches must expose identical ordered columns"
      });
    }
    columns.push(...first);
  }
  return ok(columns);
}

/** Ordered output columns of a whole view (validating union compatibility). */
export function viewColumns(view: ViewDefinition): Result<ViewColumn[], ViewError> {
  const columns: ViewColumn[] = [];
  for (const node of view.select) {
    const nodeCols = nodeColumns(node);
    if (!nodeCols.ok) return nodeCols;
    columns.push(...nodeCols.data);
  }
  return ok(columns);
}

function materializableProblem(
  view: ViewDefinition,
  allColumns: readonly ViewColumn[]
): string | undefined {
  if (view.name === undefined || !MATERIALIZABLE_NAME_PATTERN.test(view.name)) {
    return "name must match ^[a-z][a-z0-9_]{0,50}$";
  }
  const reserved = allColumns.find((column) => RESERVED_COLUMN_NAMES.includes(column.name));
  if (reserved !== undefined) return `column name '${reserved.name}' is reserved`;
  const seen = new Set<string>();
  for (const column of allColumns) {
    if (seen.has(column.name)) return `duplicate column name '${column.name}'`;
    seen.add(column.name);
  }
  return undefined;
}

/**
 * Parse the stricter materializable tier. The key column must be a TOP-LEVEL
 * (non-iterated) getResourceKey() column so every projected row keys back to
 * its canonical resource.
 */
export function parseMaterializableView(input: unknown): Result<MaterializableView, ViewError> {
  const parsed = parseViewDefinition(input);
  if (!parsed.ok) return parsed;
  const view = parsed.data;
  const keyColumn = view.select
    .filter(
      (node) =>
        node.forEach === undefined && node.forEachOrNull === undefined && node.repeat === undefined
    )
    .flatMap((node) => node.column ?? [])
    .find((column) => column.path === "getResourceKey()" && column.collection !== true);
  const allColumns = viewColumns(view);
  if (!allColumns.ok) return allColumns;
  const problem = materializableProblem(view, allColumns.data);
  if (problem !== undefined) {
    return err({ code: "VD_INVALID", message: `not materializable: ${problem}` });
  }
  if (keyColumn === undefined) {
    return err({
      code: "VD_INVALID",
      message: "not materializable: a top-level getResourceKey() column is required"
    });
  }
  if (view.name === undefined) {
    return err({ code: "VD_INVALID", message: "not materializable: name is required" });
  }
  return ok({ view, name: view.name, keyColumn: keyColumn.name });
}
