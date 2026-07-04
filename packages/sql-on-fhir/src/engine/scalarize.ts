/**
 * Column scalarization — LOCKED 3-way rule from the SQL-on-FHIR v2 spec:
 * empty => null, single => the scalar, multiple without `collection: true` =>
 * a typed error (never a silent first()-style truncation).
 */
import type { JsonValue, Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { ViewError } from "../errors.js";
import type { ViewColumn } from "../view-definition.js";

export function scalarizeColumn(
  column: ViewColumn,
  values: readonly JsonValue[]
): Result<JsonValue, ViewError> {
  if (column.collection === true) return ok([...values]);
  if (values.length === 0) return ok(null);
  if (values.length === 1) return ok(values[0] ?? null);
  return err({
    code: "VD_COLUMN_MULTIPLE_VALUES",
    message: `column '${column.name}' produced ${String(values.length)} values without collection: true`
  });
}
