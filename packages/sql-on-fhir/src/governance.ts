/**
 * Governance write composition owned above @bonfire/core: an approved proposal
 * cannot reach canonical FHIR without the typed, search-parameter, and search
 * projections sharing its tenant transaction.
 */
import type { GovernanceError, Result, SignedNote, TenantSql } from "@bonfire/core";
import { commitProposal } from "@bonfire/core";
import type { ProjectedWriteError } from "./write-projected.js";
import { writeScribeResourceProjected } from "./write-projected.js";

export function commitProjectedProposal(
  sql: TenantSql,
  input: { readonly actor: unknown; readonly proposalId: string }
): Promise<Result<SignedNote, GovernanceError | ProjectedWriteError>> {
  return commitProposal(sql, input, writeScribeResourceProjected);
}
