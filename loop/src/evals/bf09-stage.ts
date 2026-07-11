/**
 * Shared helper for the bf09 Stage-2 evals — NOT an eval itself (no jsonl row).
 * Stages one proposal through the product govern() path and returns its
 * server-issued proposalId, failing loud if the propose step returned none.
 * Extracted so the three governance security evals share ONE propose-and-extract
 * path instead of duplicating the boilerplate (repo jscpd threshold is zero).
 */
import type { Actor } from "./bf09-governance-util.js";
import { expectOk, govern } from "./bf09-governance-util.js";
import { fail } from "./eval-util.js";

export function stageProposal(
  evalId: string,
  practice: string,
  actor: Actor,
  resource: Record<string, unknown>
): string {
  const [outcome] = govern(evalId, practice, [{ op: "propose", actor, resource }]);
  if (outcome === undefined) fail(evalId, "no propose outcome");
  const proposalId = expectOk(evalId, outcome, "propose").proposalId;
  if (typeof proposalId !== "string") fail(evalId, "propose returned no proposalId");
  return proposalId;
}
