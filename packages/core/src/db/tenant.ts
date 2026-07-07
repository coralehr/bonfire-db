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
import type { Role } from "../abac/types.js";
import { ROLES } from "../abac/types.js";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import type { SqlClientOptions } from "./client.js";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";

/** Query surface handed to `withTenant` callbacks: transaction-scoped, GUC set. */
export type TenantSql = TransactionSql;

export type WithTenantErrorCode = "INVALID_PRACTICE_ID" | "TENANT_TX_FAILED";

export type ResolveMembershipErrorCode = "MEMBERSHIP_QUERY_FAILED";

/** The authority a verified external identity maps to (BF-13). */
export interface Membership {
  readonly practiceId: string;
  readonly role: Role;
}

export interface TenantDb {
  /**
   * Run `fn` inside a tenant-scoped transaction. Invalid practice ids and any
   * database failure (including RLS WITH CHECK denials) surface as a typed
   * error Result — never a throw, never a fail-open read.
   */
  withTenant<T>(
    practiceId: string,
    fn: (sql: TenantSql) => Promise<T>
  ): Promise<Result<T, BonfireError<WithTenantErrorCode>>>;
  /**
   * Resolve a verified external identity (iss, sub) to its practice + role
   * (BF-13). Runs with NO tenant GUC — this read HAPPENS BEFORE a practice
   * context exists (you read this row to LEARN the practice_id), so it relies
   * on the membership table's GUC-independent SELECT policy, not withTenant.
   * The lookup is a single parameterized equality query; `ok(null)` means the
   * identity is authenticated but not a member (deny), a value means a hit, and
   * a DB fault is a typed err (fail-closed). practice_id/role come ONLY from
   * here — never from a token claim or request input (claims-not-trusted).
   */
  resolveMembership(
    iss: string,
    sub: string
  ): Promise<Result<Membership | null, BonfireError<ResolveMembershipErrorCode>>>;
  /** Close the underlying pool (graceful shutdown). */
  end(): Promise<void>;
}

const practiceIdSchema = z.uuid();
const membershipRowSchema = z.object({ practice_id: z.uuid(), role: z.enum(ROLES) });
const END_TIMEOUT_SECONDS = 5;

/** Wrap an existing client. Internal seam — tests compose it with a max:1 pool. */
export function createTenantDb(sql: Sql): TenantDb {
  return {
    async withTenant<T>(
      practiceId: string,
      fn: (sql: TenantSql) => Promise<T>
    ): Promise<Result<T, BonfireError<WithTenantErrorCode>>> {
      const parsed = practiceIdSchema.safeParse(practiceId);
      if (!parsed.success) {
        return err({ code: "INVALID_PRACTICE_ID", message: "practiceId must be a UUID" });
      }
      // Captured via closure (not begin's return value) so the callback's type
      // stays concrete — postgres.js wraps returns in UnwrapPromiseArray, which
      // never resolves over a free generic. The callback handle shadow-names the
      // outer pool `sql` on purpose: the un-pinned client is unreachable inside
      // the transaction, so no statement can escape the tenant GUC.
      let captured: { readonly value: T } | undefined;
      try {
        await sql.begin(async (sql) => {
          await sql`select set_config('app.current_practice_id', ${parsed.data}, true)`;
          captured = { value: await fn(sql) };
        });
      } catch (_cause) {
        return err({ code: "TENANT_TX_FAILED", message: "tenant-scoped transaction failed" });
      }
      if (captured === undefined) {
        return err({ code: "TENANT_TX_FAILED", message: "transaction yielded no result" });
      }
      return ok(captured.value);
    },
    async resolveMembership(
      iss: string,
      sub: string
    ): Promise<Result<Membership | null, BonfireError<ResolveMembershipErrorCode>>> {
      try {
        // No set_config: this read runs BEFORE any tenant context (it produces
        // the practice_id). Parameterized equality only; membership's SELECT
        // policy is GUC-independent, and its transaction-local absence means a
        // reused pooled connection carries no prior tenant's context.
        const rows = await sql`
          select practice_id::text as practice_id, role
          from membership
          where iss = ${iss} and sub = ${sub}
          limit 1`;
        if (rows[0] === undefined) return ok(null);
        const parsed = membershipRowSchema.safeParse(rows[0]);
        if (!parsed.success) return ok(null);
        return ok({ practiceId: parsed.data.practice_id, role: parsed.data.role });
      } catch (_cause) {
        return err({ code: "MEMBERSHIP_QUERY_FAILED", message: "membership lookup failed" });
      }
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
