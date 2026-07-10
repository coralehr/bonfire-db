/**
 * `useClinicalQuery` — a framework-free reactive store over Postgres
 * LISTEN/NOTIFY (security unit U3). NOT a React hook: the name is
 * contract-pinned and the shape is useSyncExternalStore-compatible
 * (subscribe/getSnapshot), so a React adapter is one call away.
 *
 * Tenant scoping is STRUCTURAL, never wire-trusted: the notification payload
 * is a constant table name carrying zero tenant data, and the ONLY data path
 * is the RLS-scoped re-query inside withTenant(session.practiceId). A spoofed
 * NOTIFY is a harmless re-query; a subscriber emits ONLY when its own scoped
 * snapshot's content hash changes, so another practice's activity can never
 * surface here — not even as timing.
 *
 * ponytail: reconnect resync rides the listener's onListen callback (fired on
 * LISTEN confirm and on every reconnect). If the driver's reconnect goes
 * permanently silent there is no staleness guarantee — refresh() is the
 * manual escape hatch and a polling fallback is the upgrade path if that
 * ceiling is ever hit. close() unlistens, but only db.end() on the listener's
 * owning client reclaims the socket.
 */
import type { BonfireError, Result, TenantDb } from "@bonfire/core";
import { err, ok, sha256Hex } from "@bonfire/core";
import { z } from "zod";
import type { BonfireSession } from "../auth/session.js";
import type { ClinicalView } from "./views.js";
import { clinicalViewSchema } from "./views.js";

/** The one wake-up channel the 0011 projection triggers NOTIFY on. */
const PROJECTION_CHANNEL = "bonfire_projection_change";
/** Trailing debounce so a burst of statements coalesces into one re-query. */
const DEBOUNCE_MS = 150;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** What `listen` resolves to; unlisten stops deliveries for this store. */
export interface ListenHandle {
  unlisten(): Promise<void>;
}

/** Structural LISTEN surface — a raw postgres.js client satisfies it as-is. */
export interface ProjectionListener {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen: () => void
  ): Promise<ListenHandle>;
}

export interface ClinicalQueryOptions {
  readonly view: ClinicalView;
  readonly limit?: number;
}

export type ClinicalRow = Readonly<Record<string, unknown>>;

export interface ClinicalQuerySnapshot {
  readonly rows: readonly ClinicalRow[];
}

export interface ClinicalQueryStore {
  /** Latest emitted snapshot (null until the first scoped load completes). */
  getSnapshot(): ClinicalQuerySnapshot | null;
  /** Register a change callback; returns the matching unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Manual re-query escape hatch (bypasses the debounce). */
  refresh(): Promise<void>;
  /** Stop timers and unlisten. The socket itself is reclaimed by db.end(). */
  close(): Promise<void>;
}

export type ClinicalQueryErrorCode = "INVALID_QUERY_OPTIONS";

const clinicalQueryOptionsSchema = z.object({
  view: clinicalViewSchema,
  limit: z.number().int().min(1).max(MAX_LIMIT).optional()
});

interface StoreState {
  readonly db: TenantDb;
  readonly practiceId: string;
  readonly view: ClinicalView;
  readonly limit: number;
  snapshot: ClinicalQuerySnapshot | null;
  contentHash: string | null;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerun: boolean;
  readonly subscribers: Set<() => void>;
}

/**
 * The ONLY data path: an RLS-scoped select in a fresh tenant transaction. The
 * view name is an identifier spliced via sql(name) strictly AFTER the zod
 * whitelist; rows are totally ordered so the content hash is deterministic.
 */
async function loadRows(state: StoreState): Promise<readonly ClinicalRow[] | null> {
  const result = await state.db.withTenant(
    state.practiceId,
    async (sql): Promise<ClinicalRow[]> => {
      const rows = await sql`
      select * from ${sql(state.view)} order by id, row_index limit ${state.limit}`;
      return [...rows];
    }
  );
  // A failed re-query keeps the last snapshot: stale, never cross-tenant and
  // never fail-open. refresh() is the caller's escape hatch.
  return result.ok ? result.data : null;
}

/** Emit to subscribers ONLY when the scoped snapshot content actually changed. */
function emitIfChanged(state: StoreState, rows: readonly ClinicalRow[]): void {
  const nextHash = sha256Hex(JSON.stringify(rows));
  if (nextHash === state.contentHash) return;
  state.contentHash = nextHash;
  state.snapshot = { rows };
  for (const notifySubscriber of [...state.subscribers]) notifySubscriber();
}

/** Opaque reads: `closed`/`rerun` mutate across awaits (close(), wake-ups),
 *  so they are read through calls that control flow cannot narrow away. */
function stillOpen(state: StoreState): boolean {
  return !state.closed;
}

function takeRerun(state: StoreState): boolean {
  if (state.closed || !state.rerun) return false;
  state.rerun = false;
  return true;
}

/** Single-flight re-query: overlapping wake-ups coalesce into one trailing run. */
async function requery(state: StoreState): Promise<void> {
  if (state.closed) return;
  if (state.running) {
    state.rerun = true;
    return;
  }
  state.running = true;
  state.rerun = true;
  try {
    while (takeRerun(state)) {
      const rows = await loadRows(state);
      if (rows !== null && stillOpen(state)) emitIfChanged(state, rows);
    }
  } finally {
    state.running = false;
  }
}

function scheduleRequery(state: StoreState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void requery(state);
  }, DEBOUNCE_MS);
}

function buildStore(state: StoreState, handle: Promise<ListenHandle | null>): ClinicalQueryStore {
  return {
    getSnapshot: () => state.snapshot,
    subscribe: (onChange) => {
      state.subscribers.add(onChange);
      return () => {
        state.subscribers.delete(onChange);
      };
    },
    refresh: () => requery(state),
    close: async () => {
      state.closed = true;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.subscribers.clear();
      const listenHandle = await handle;
      if (listenHandle !== null) await listenHandle.unlisten();
    }
  };
}

/**
 * Open a reactive, tenant-scoped store over one whitelisted vd_* projection.
 * LISTEN registers FIRST and the initial scoped snapshot runs INSIDE onListen,
 * so one idempotent resync path covers first load AND every reconnect — there
 * is no missed-commit window between snapshot and LISTEN.
 */
export function useClinicalQuery(
  session: BonfireSession,
  db: TenantDb,
  listener: ProjectionListener,
  options: ClinicalQueryOptions
): Result<ClinicalQueryStore, BonfireError<ClinicalQueryErrorCode>> {
  const parsed = clinicalQueryOptionsSchema.safeParse(options);
  if (!parsed.success) {
    return err({
      code: "INVALID_QUERY_OPTIONS",
      message: "view must be a whitelisted vd_* projection (limit 1..1000)"
    });
  }
  const state: StoreState = {
    db,
    practiceId: session.practiceId,
    view: parsed.data.view,
    limit: parsed.data.limit ?? DEFAULT_LIMIT,
    snapshot: null,
    contentHash: null,
    closed: false,
    timer: null,
    running: false,
    rerun: false,
    subscribers: new Set()
  };
  const handle: Promise<ListenHandle | null> = listener
    .listen(
      PROJECTION_CHANNEL,
      (payload) => {
        if (payload === state.view && !state.closed) scheduleRequery(state);
      },
      () => {
        void requery(state);
      }
    )
    // A failed LISTEN registration leaves an empty store (never a throw);
    // refresh() still works because it queries through withTenant directly.
    .then(
      (listenHandle) => listenHandle,
      () => null
    );
  return ok(buildStore(state, handle));
}
