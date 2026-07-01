/**
 * Zero-dependency advisory file lock (the proper-lockfile algorithm, reimplemented).
 *
 * Neither Node nor Bun exposes flock(); the portable primitive is an atomic
 * `mkdir` of `<file>.lock` (EEXIST = contended). The holder records its pid in
 * `owner.json`. A waiter treats the lock as STALE when its mtime is older than
 * the stale window AND the recorded pid is dead — it then removes the lock and
 * RE-CONTENDS through mkdir (never assumes ownership after removal; two
 * recoverers must race through the atomic primitive again).
 *
 * Synchronous by design (matches the harness's sync style); the wait is a real
 * block via Atomics.wait, which Node/Bun permit on the main thread.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_SUFFIX = ".lock";
const STALE_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 15;

const INT32_BYTES = 4;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
}

/** Test seam: production callers omit this and get the safe defaults. */
export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerPid(lockDir: string): number | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") {
      return raw.pid;
    }
    return null;
  } catch {
    return null;
  }
}

/** Stale = old enough AND the recorded holder is gone (or unreadable). */
function isStale(lockDir: string, staleMs: number): boolean {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age < staleMs) return false;
    const pid = ownerPid(lockDir);
    return pid === null || !isPidAlive(pid);
  } catch {
    // Lock vanished between mkdir failure and stat — treat as contended, retry.
    return false;
  }
}

function tryAcquire(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the advisory lock for `file`. Throws if the lock cannot
 * be acquired within the timeout — a held-forever lock is a programmer error /
 * dead process, and proceeding without it would risk a lost write.
 */
export function withFileLock<T>(file: string, fn: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const lockDir = `${file}${LOCK_SUFFIX}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryAcquire(lockDir)) break;
    if (isStale(lockDir, staleMs)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue; // re-contend through mkdir — never assume ownership
    }
    if (Date.now() > deadline) {
      throw new Error(`could not acquire lock ${lockDir} within ${String(timeoutMs)}ms`);
    }
    sleepSync(RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS);
  }

  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
