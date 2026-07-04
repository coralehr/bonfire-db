/**
 * SQL-backed concept lookup over the GLOBAL bundled terminology tables. Runs on
 * the same tenant transaction handle as the write, but terminology_concept /
 * terminology_pack carry no practice_id and are SELECT-only for bonfire_app —
 * reference data, never PHI. Parameterized `sql` templates only (no interpolated
 * SQL); the pack version is read from the concept rows the loader stamped.
 */
import { z } from "zod";
import type { TenantSql } from "../db/tenant.js";
import type { TerminologyConceptLookup } from "./bundled-pack-validator.js";

const conceptRowSchema = z.object({ version: z.string() });

function firstVersion(rows: readonly unknown[]): string | undefined {
  const parsed = conceptRowSchema.safeParse(rows[0]);
  return parsed.success ? parsed.data.version : undefined;
}

/** A concept lookup that reads the bundled packs via a tenant transaction handle. */
export function createSqlConceptLookup(sql: TenantSql): TerminologyConceptLookup {
  return {
    async findConcept(
      system: string,
      code: string
    ): Promise<{ readonly version: string } | undefined> {
      const rows = await sql`
        select version from terminology_concept
        where system = ${system} and code = ${code} limit 1`;
      const version = firstVersion(rows);
      return version === undefined ? undefined : { version };
    },
    async packVersion(system: string): Promise<string | undefined> {
      const rows = await sql`
        select version from terminology_concept
        where system = ${system} limit 1`;
      return firstVersion(rows);
    }
  };
}
