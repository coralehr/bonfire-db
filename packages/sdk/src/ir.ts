/**
 * The type-schema IR the SDK client is generated FROM. One entry per public
 * operation the SDK mirrors; `bun run --filter @bonfire/sdk gen` renders
 * src/generated/client.gen.ts deterministically from this table (entries
 * pre-sorted by method name, no timestamps, byte-identical on rerun).
 */
export interface OpSpec {
  /** Generated client method name. */
  readonly method: string;
  /** Hand-written adapter (ops.ts export) the generated method delegates to. */
  readonly adapter: string;
  /** Method input type name (ops.ts export; a subject is NEVER caller input). */
  readonly inputType: string;
  /** Method result type name (ops.ts export; a Result — the SDK never throws). */
  readonly resultType: string;
  /** TSDoc summary emitted onto the generated method. */
  readonly doc: string;
}

export const OPS: readonly OpSpec[] = [
  {
    method: "buildCcp",
    adapter: "opBuildCcp",
    inputType: "BuildCcpInput",
    resultType: "BuildCcpResult",
    doc: "Build a span-cited context projection (BF-07 buildCcp) from a scoped search response."
  },
  {
    method: "proposeResource",
    adapter: "opProposeResource",
    inputType: "ProposeResourceInput",
    resultType: "ProposeResourceResult",
    doc: "Stage a typed clinical write as a BF-09 governance proposal (proposeRecord). Nothing reaches the canonical FHIR store until a clinician approves and commits the proposal; the returned record carries the proposal id and state 'proposed'."
  },
  {
    method: "searchClinical",
    adapter: "opSearchClinical",
    inputType: "SearchClinicalInput",
    resultType: "SearchClinicalResult",
    doc: "Run the scope-before-retrieve cited hybrid search (BF-06 searchClinical)."
  }
];
