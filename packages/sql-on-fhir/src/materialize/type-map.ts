/**
 * FHIR column type -> Postgres column type. CLOSED map, LOCKED decisions:
 *  - decimal AND every temporal (date/dateTime/instant/time) map to TEXT:
 *    "1.50" != "1.5" and partial dates like "2015-02" break under
 *    numeric/timestamptz, and byte-identical drop+rebuild requires a
 *    representation-stable column.
 *  - collection columns and complex types map to JSONB.
 */
export type PgColumnType = "boolean" | "integer" | "text" | "jsonb";

const SCALAR_TYPE_MAP: Readonly<Record<string, PgColumnType>> = {
  boolean: "boolean",
  integer: "integer",
  positiveInt: "integer",
  unsignedInt: "integer",
  decimal: "text",
  date: "text",
  dateTime: "text",
  instant: "text",
  time: "text",
  id: "text",
  string: "text",
  code: "text",
  uri: "text",
  url: "text",
  canonical: "text",
  oid: "text",
  uuid: "text",
  markdown: "text",
  base64Binary: "text"
};

/** Resolve the Postgres type for a declared column. */
export function pgColumnType(
  fhirType: string | undefined,
  collection: boolean | undefined
): PgColumnType {
  if (collection === true) return "jsonb";
  if (fhirType === undefined) return "jsonb";
  return SCALAR_TYPE_MAP[fhirType] ?? "jsonb";
}
