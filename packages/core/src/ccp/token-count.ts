/**
 * Offline token-measurement hook (acceptance #6/#7). The default counter is
 * gpt-tokenizer's o200k_base encoding — pure JS with bundled ranks, so every
 * measurement runs fully offline with zero API keys (the BP-035 no-egress
 * floor covers ccp/** structurally). The baseline is the compact JSON of the
 * IDENTICAL span set: this measures the serialization-residual lever only;
 * the 10-100x reduction from returning only the scoped slice is BF-06's claim
 * and is not re-measured here.
 */
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { CcpDocument } from "./schemas.js";

export interface TokenCounter {
  /** Names the tokenizer a measurement was made under — never implicit. */
  readonly tokenizerId: string;
  count(text: string): number;
}

/** The default pluggable counter: bundled o200k_base ranks, offline, zero keys. */
export const o200kCounter: TokenCounter = {
  tokenizerId: "gpt-tokenizer/o200k_base",
  count: (text: string): number => countTokens(text)
};

export interface CcpTokenMeasurement {
  readonly tokenizerId: string;
  readonly ccpTokens: number;
  readonly baselineTokens: number;
  /** baselineTokens / ccpTokens — above 1 means the CCP text is smaller. */
  readonly ratio: number;
}

/** Measure a CCP text against compact JSON of the identical span set. */
export function measureCcp(
  doc: CcpDocument,
  counter: TokenCounter = o200kCounter
): CcpTokenMeasurement {
  const ccpTokens = counter.count(doc.text);
  const baselineTokens = counter.count(JSON.stringify(doc.spans));
  return {
    tokenizerId: counter.tokenizerId,
    ccpTokens,
    baselineTokens,
    ratio: baselineTokens / ccpTokens
  };
}
