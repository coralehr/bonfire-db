/**
 * THE fhirpath.js boundary — the only module that imports fhirpath. Everything
 * the engine needs is exposed as typed, Result-returning functions over an
 * opaque `PathContext`, so `any`-shaped library output never escapes this file
 * un-narrowed (raw results pass through `unknown` + Zod).
 *
 * fhirpath is pinned EXACTLY at 4.10.1 (a fake-conformance control): the
 * vendored HL7 suite was validated against this version. Never bump it here.
 */
import type { JsonValue, Result } from "@bonfire/core";
import { err, jsonValueSchema, ok } from "@bonfire/core";
import fhirpath from "fhirpath";
import r4Model from "fhirpath/fhir-context/r4/index.js";
import fhirpathInternals from "fhirpath/src/types.js";
import { z } from "zod";
import type { ViewError } from "./errors.js";

/** Opaque evaluation focus: a raw FHIR resource or an internal fhirpath node. */
export interface PathContext {
  readonly node: unknown;
}

/** Environment variables handed to one evaluation (constants + %rowIndex). */
export type PathEnv = Readonly<Record<string, unknown>>;

/** Wrap a raw FHIR resource (or any JSON subtree) as an evaluation focus. */
export function rootContext(resource: JsonValue): PathContext {
  return { node: resource };
}

/**
 * Focus used for forEachOrNull null rows: every data path resolves to empty
 * (=> null column) while %rowIndex still resolves, mirroring the reference
 * runner's behavior of evaluating the subtree against an empty node.
 */
export function emptyContext(): PathContext {
  return { node: {} };
}

const REFERENCE_TYPE_OFFSET = -2;

function referenceKeySegments(reference: unknown): { type: string; id: string } | undefined {
  if (typeof reference !== "string") return undefined;
  const segments = reference.split("/").filter((segment) => segment.length > 0);
  const id = segments.at(-1);
  const type = segments.at(REFERENCE_TYPE_OFFSET);
  if (id === undefined || type === undefined) return undefined;
  return { type, id };
}

const typeSpecifierSchema = z.object({ name: z.string() });
const referenceHolderSchema = z.object({ reference: z.unknown().optional() });

function getReferenceKeyImpl(focus: unknown, typeSpecifier?: unknown): unknown[] {
  const focusItems = Array.isArray(focus) ? focus : [focus];
  const wanted = typeSpecifierSchema.safeParse(typeSpecifier);
  return focusItems.flatMap((item) => {
    const holder = referenceHolderSchema.safeParse(item);
    if (!holder.success) return [];
    const key = referenceKeySegments(holder.data.reference);
    if (key === undefined) return [];
    if (wanted.success && key.type !== wanted.data.name) return [];
    return [key.id];
  });
}

const resourceKeyHolderSchema = z.object({ id: z.unknown().optional() });

function getResourceKeyImpl(focus: unknown): unknown[] {
  const focusItems = Array.isArray(focus) ? focus : [focus];
  return focusItems.flatMap((item) => {
    const holder = resourceKeyHolderSchema.safeParse(item);
    if (!holder.success || holder.data.id === undefined) return [];
    return [holder.data.id];
  });
}

function unsupportedExperimental(name: string): () => never {
  return () => {
    throw new Error(
      `${name}() is upstream-experimental and outside the supported shareable surface`
    );
  };
}

/**
 * One frozen options object per mode. SQL-on-FHIR's getResourceKey /
 * getReferenceKey are not fhirpath built-ins; they are registered here. The
 * upstream-experimental functions in the pinned declared-unsupported set are
 * explicitly DISABLED (not incidentally available), so the engine's claimed
 * surface is exactly the shareable set and a future fhirpath upgrade cannot
 * silently change what "conformant" means (fake-conformance control; the
 * allowlist honesty check fails the run if these ever start passing).
 */
const baseInvocationTable = {
  getResourceKey: { fn: getResourceKeyImpl, arity: { 0: [] } },
  getReferenceKey: {
    fn: getReferenceKeyImpl,
    arity: { 0: [], 1: ["TypeSpecifier" as const] }
  },
  join: { fn: unsupportedExperimental("join"), arity: { 0: [], 1: ["String" as const] } },
  lowBoundary: { fn: unsupportedExperimental("lowBoundary"), arity: { 0: [] } },
  highBoundary: { fn: unsupportedExperimental("highBoundary"), arity: { 0: [] } }
};

// Re-shape the model namespace for exactOptionalPropertyTypes: the published
// typing marks `score` as `... | undefined`, which is not assignable to the
// optional property on `Model` — drop the key entirely when absent.
const { score: modelScore, ...modelRest } = r4Model;
const fhirModel = modelScore === undefined ? modelRest : { ...modelRest, score: modelScore };

const ASYNC_OFF = false as const;
const valueOptions = Object.freeze({
  userInvocationTable: baseInvocationTable,
  async: ASYNC_OFF
});
const nodeOptions = Object.freeze({
  userInvocationTable: baseInvocationTable,
  resolveInternalTypes: false,
  async: ASYNC_OFF
});

type CompiledPath = (resource: unknown, envVars?: Record<string, unknown>) => unknown;

const valueCompileCache = new Map<string, CompiledPath>();
const nodeCompileCache = new Map<string, CompiledPath>();

function compilePath(expression: string, mode: "value" | "node"): Result<CompiledPath, ViewError> {
  const cache = mode === "value" ? valueCompileCache : nodeCompileCache;
  const cached = cache.get(expression);
  if (cached !== undefined) return ok(cached);
  try {
    const compiled = fhirpath.compile(
      expression,
      fhirModel,
      mode === "value" ? valueOptions : nodeOptions
    );
    cache.set(expression, compiled);
    return ok(compiled);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ code: "VD_FHIRPATH_INVALID", message: `invalid FHIRPath: ${message}` });
  }
}

/** Pre-parse an expression so malformed paths fail before any data is read. */
export function checkPath(expression: string): Result<true, ViewError> {
  const compiled = compilePath(expression, "value");
  return compiled.ok ? ok(true) : compiled;
}

function runCompiled(
  compiled: CompiledPath,
  context: PathContext,
  env: PathEnv
): Result<unknown[], ViewError> {
  try {
    const raw: unknown = compiled(context.node, { ...env });
    const items = z.array(z.unknown()).safeParse(raw);
    if (!items.success) {
      return err({ code: "VD_EVAL_FAILED", message: "fhirpath returned a non-array result" });
    }
    return ok(items.data);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ code: "VD_EVAL_FAILED", message: `fhirpath evaluation failed: ${message}` });
  }
}

const jsonValuesSchema = z.array(jsonValueSchema);

/** Evaluate to fully-resolved JSON values (column and where expressions). */
export function evaluateValues(
  context: PathContext,
  expression: string,
  env: PathEnv
): Result<JsonValue[], ViewError> {
  const compiled = compilePath(expression, "value");
  if (!compiled.ok) return compiled;
  const raw = runCompiled(compiled.data, context, env);
  if (!raw.ok) return raw;
  const parsed = jsonValuesSchema.safeParse(raw.data);
  if (!parsed.success) {
    return err({
      code: "VD_VALUE_NOT_JSON",
      message: `expression '${expression}' produced a non-JSON value`
    });
  }
  return ok(parsed.data);
}

/** Evaluate to type-preserving nodes (forEach / forEachOrNull / repeat). */
export function evaluateNodes(
  context: PathContext,
  expression: string,
  env: PathEnv
): Result<PathContext[], ViewError> {
  const compiled = compilePath(expression, "node");
  if (!compiled.ok) return compiled;
  const raw = runCompiled(compiled.data, context, env);
  if (!raw.ok) return raw;
  return ok(raw.data.map((node) => ({ node })));
}

/**
 * Convert a ViewDefinition constant to a typed environment value. Temporal
 * constants must become fhirpath primitives — a plain string compares as
 * System.String against FHIR date/dateTime/instant/time nodes and is never
 * equal (verified against the pinned fhirpath 4.10.1).
 */
export function constantEnvValue(valueKind: string, value: string | number | boolean): unknown {
  if (typeof value !== "string") return value;
  switch (valueKind) {
    case "valueDate":
      return new fhirpathInternals.FP_Date({}, value);
    case "valueDateTime":
      return new fhirpathInternals.FP_DateTime({}, value);
    case "valueInstant":
      return new fhirpathInternals.FP_Instant({}, value);
    case "valueTime":
      return new fhirpathInternals.FP_Time({}, value);
    default:
      return value;
  }
}
