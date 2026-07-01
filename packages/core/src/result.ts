/**
 * CQ2 boundary idiom: expected, recoverable failures are VALUES, never throws.
 * This is the PRODUCT Result type (packages/core) — the harness has its own and
 * the two must never be shared (loop/** is firewalled from the product).
 */
export type Result<T, E> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E };

/**
 * The product error shape: a stable machine-readable `code` callers branch on
 * (never string-match on messages) plus a human-readable, secret-free message.
 */
export interface BonfireError<C extends string = string> {
  readonly code: C;
  readonly message: string;
}

/** Wrap a success value in the ok arm of the Result union. */
export function ok<T>(data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data };
}

/** Wrap an expected failure in the error arm of the Result union. */
export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
