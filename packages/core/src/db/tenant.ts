/**
 * `withTenant` — the ONLY exported query path of @bonfire/core.
 *
 * Every read/write runs inside ONE transaction whose FIRST statement binds the
 * tenant GUC transaction-locally (set_config(..., true)); the RLS policies on
 * every tenant table key off that GUC. Session-level SET is banned: the GUC
 * dies with the transaction, so a pooled connection can never bleed practice A
 * context into practice B's next query.
 */
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import type { SqlClientOptions } from "./client.js";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";

/** Query surface handed to `withTenant` callbacks: transaction-scoped, GUC set. */
export type TenantSql = TransactionSql;

export type WithTenantErrorCode = "INVALID_PRACTICE_ID" | "TENANT_TX_FAILED";

export interface TenantDb {
  /**
   * Run `fn` inside a tenant-scoped transaction. Invalid practice ids and any
   * database failure (including RLS WITH CHECK denials) surface as a typed
   * error Result — never a throw, never a fail-open read.
   */
  withTenant<T>(
    practiceId: string,
    fn: (tx: TenantSql) => Promise<T>
  ): Promise<Result<T, BonfireError<WithTenantErrorCode>>>;
  /** Close the underlying pool (graceful shutdown). */
  end(): Promise<void>;
}

const practiceIdSchema = z.uuid();
const END_TIMEOUT_SECONDS = 5;

// Parameterized via postgres.js bound params ($1) — the practice id is never
// interpolated into statement text. `.unsafe` is used (not a tagged template)
// because the repo's SQL-template guard rejects any interpolated template; a
// bound-parameter literal string is the sanctioned parameterized form.
const SET_TENANT_GUC = "select set_config('app.current_practice_id', $1, true)";

/** Wrap an existing client. Internal seam — tests compose it with a max:1 pool. */
export function createTenantDb(sql: Sql): TenantDb {
  return {
    async withTenant<T>(
      practiceId: string,
      fn: (tx: TenantSql) => Promise<T>
    ): Promise<Result<T, BonfireError<WithTenantErrorCode>>> {
      const parsed = practiceIdSchema.safeParse(practiceId);
      if (!parsed.success) {
        return err({ code: "INVALID_PRACTICE_ID", message: "practiceId must be a UUID" });
      }
      // Captured via closure (not begin's return value) so the callback's type
      // stays concrete — postgres.js wraps returns in UnwrapPromiseArray, which
      // never resolves over a free generic.
      let captured: { readonly value: T } | undefined;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(SET_TENANT_GUC, [parsed.data]);
          captured = { value: await fn(tx) };
        });
      } catch (_cause) {
        return err({ code: "TENANT_TX_FAILED", message: "tenant-scoped transaction failed" });
      }
      if (captured === undefined) {
        return err({ code: "TENANT_TX_FAILED", message: "transaction yielded no result" });
      }
      return ok(captured.value);
    },
    end(): Promise<void> {
      return sql.end({ timeout: END_TIMEOUT_SECONDS });
    }
  };
}

/** Connect using the environment's app-role target (the public entry point). */
export function connectTenantDb(options: SqlClientOptions = {}): TenantDb {
  return createTenantDb(createSqlClient(resolveDatabaseTarget(), options));
}
