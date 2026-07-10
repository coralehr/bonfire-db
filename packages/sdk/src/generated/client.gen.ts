/**
 * GENERATED FILE — do not edit by hand.
 * Rendered by `bun run --filter @bonfire/sdk gen` from src/ir.ts;
 * the gate re-runs the generator and fails on any drift.
 */
import type { TenantDb } from "@bonfire/core";
import type { BonfireSession } from "../auth/session.js";
import type {
  BuildCcpInput,
  BuildCcpResult,
  ProposeResourceInput,
  ProposeResourceResult,
  SearchClinicalInput,
  SearchClinicalResult
} from "../ops.js";
import { opBuildCcp, opProposeResource, opSearchClinical } from "../ops.js";
import { runOp } from "../run-op.js";

/** One typed method per mirrored public operation; every method returns a Result. */
export interface BonfireClient {
  /** Build a span-cited context projection (BF-07 buildCcp) from a scoped search response. */
  buildCcp(input: BuildCcpInput): Promise<BuildCcpResult>;
  /** Propose a typed clinical write (BF-03 writeScribeResource). The write lands in the tenant's canonical FHIR store when the call returns; approve/commit governance is BF-09. */
  proposeResource(input: ProposeResourceInput): Promise<ProposeResourceResult>;
  /** Run the scope-before-retrieve cited hybrid search (BF-06 searchClinical). */
  searchClinical(input: SearchClinicalInput): Promise<SearchClinicalResult>;
}

/** Bind a session to the ONE runOp executor behind the generated surface. */
export function createBonfireClient(db: TenantDb, session: BonfireSession): BonfireClient {
  return {
    buildCcp: (input: BuildCcpInput): Promise<BuildCcpResult> =>
      runOp(db, session, opBuildCcp, input),
    proposeResource: (input: ProposeResourceInput): Promise<ProposeResourceResult> =>
      runOp(db, session, opProposeResource, input),
    searchClinical: (input: SearchClinicalInput): Promise<SearchClinicalResult> =>
      runOp(db, session, opSearchClinical, input)
  };
}
