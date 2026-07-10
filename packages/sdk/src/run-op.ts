/**
 * The ONE executor every generated client method delegates to: bind the
 * session's tenant with `withTenant`, derive the ABAC subject from the session
 * (id = audited actor, role/practiceId = membership row), run the core op, and
 * flatten the nested Result. The SDK boundary NEVER throws — an unexpected
 * throw surfaces as err(SDK_UNEXPECTED) — and all logic lives here so the
 * generated methods stay one-line delegations.
 */
import type {
  BonfireError,
  Result,
  Subject,
  TenantDb,
  TenantSql,
  WithTenantErrorCode
} from "@bonfire/core";
import { err } from "@bonfire/core";
import type { BonfireSession } from "./auth/session.js";

/** Codes the SDK layer itself can add on top of an operation's own union. */
export type SdkErrorCode = WithTenantErrorCode | "SDK_UNEXPECTED";

/** A hand-written per-operation adapter (see ops.ts). */
export type OpAdapter<TIn, TOk, TErr> = (
  sql: TenantSql,
  subject: Subject,
  input: TIn
) => Promise<Result<TOk, TErr>>;

export async function runOp<TIn, TOk, TErr extends BonfireError>(
  db: TenantDb,
  session: BonfireSession,
  op: OpAdapter<TIn, TOk, TErr>,
  input: TIn
): Promise<Result<TOk, TErr | BonfireError<SdkErrorCode>>> {
  const subject: Subject = {
    id: session.actorId,
    role: session.role,
    practiceId: session.practiceId
  };
  try {
    const outcome = await db.withTenant(session.practiceId, (sql) => op(sql, subject, input));
    return outcome.ok ? outcome.data : outcome;
  } catch (_cause) {
    return err({ code: "SDK_UNEXPECTED", message: "unexpected SDK boundary failure" });
  }
}
