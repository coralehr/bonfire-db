import { createHash, randomUUID } from "node:crypto";

export type AuditDecision = "allow" | "deny";
export type AuditMutation = "update" | "delete";

export interface AppendAuditEventInput {
  practiceId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  decision: AuditDecision;
  reason: string;
  receipt?: unknown;
}

export interface AuditEvent extends AppendAuditEventInput {
  id: string;
  prevHash: string;
  rowHash: string;
  createdAt: string;
}

export interface AppendAuditEventOptions {
  id?: string;
  createdAt?: string;
}

export type AuditHashPayload = Omit<AuditEvent, "rowHash">;

export type AuditHashChainResult =
  | { valid: true }
  | { valid: false; index: number; reason: "prev_hash_mismatch" | "row_hash_mismatch"; expected: string; actual: string };

export const auditZeroHash = "0".repeat(64);

export class BonfireAuditMutationDenied extends Error {
  readonly code = "BONFIRE_AUDIT_MUTATION_DENIED";
  readonly mutation: AuditMutation;

  constructor(mutation: AuditMutation) {
    super(`audit_events is append-only; ${mutation} is not allowed`);
    this.name = "BonfireAuditMutationDenied";
    this.mutation = mutation;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;

  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }

  return Object.freeze(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function auditEventHash(payload: AuditHashPayload): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function hashPayloadFor(event: AuditEvent): AuditHashPayload {
  const { rowHash: _rowHash, ...payload } = event;
  return payload;
}

export class AppendOnlyAuditLedger {
  readonly #events: AuditEvent[] = [];

  constructor(seedEvents: readonly AuditEvent[] = []) {
    this.#events.push(...seedEvents.map((event) => deepFreeze(cloneJson(event))));
  }

  append(input: AppendAuditEventInput, options: AppendAuditEventOptions = {}): AuditEvent {
    const previous = this.#events.at(-1);
    const payload: AuditHashPayload = {
      id: options.id ?? randomUUID(),
      practiceId: input.practiceId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      decision: input.decision,
      reason: input.reason,
      prevHash: previous?.rowHash ?? auditZeroHash,
      createdAt: options.createdAt ?? new Date().toISOString()
    };

    if (input.receipt !== undefined) payload.receipt = input.receipt;

    const canonicalPayload = canonicalize(payload) as AuditHashPayload;
    const event = deepFreeze({
      ...canonicalPayload,
      rowHash: auditEventHash(canonicalPayload)
    });

    this.#events.push(event);
    return cloneJson(event);
  }

  list(): readonly AuditEvent[] {
    return this.#events.map((event) => cloneJson(event));
  }

  update(_eventId: string, _patch: Partial<AuditEvent>): never {
    throw new BonfireAuditMutationDenied("update");
  }

  delete(_eventId: string): never {
    throw new BonfireAuditMutationDenied("delete");
  }
}

export function verifyAuditHashChain(events: readonly AuditEvent[]): AuditHashChainResult {
  let expectedPrevHash = auditZeroHash;

  for (const [index, event] of events.entries()) {
    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        index,
        reason: "prev_hash_mismatch",
        expected: expectedPrevHash,
        actual: event.prevHash
      };
    }

    const expectedRowHash = auditEventHash(hashPayloadFor(event));
    if (event.rowHash !== expectedRowHash) {
      return {
        valid: false,
        index,
        reason: "row_hash_mismatch",
        expected: expectedRowHash,
        actual: event.rowHash
      };
    }

    expectedPrevHash = event.rowHash;
  }

  return { valid: true };
}
