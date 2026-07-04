/**
 * SNOMED CT is validated for SCTID/URI FORMAT ONLY — no concept content is ever
 * bundled (IHTSDO affiliate licensing). A well-formed SCTID is 6–18 digits with
 * no leading zero, a recognised partition identifier, and a valid trailing
 * Verhoeff check digit. This NEVER blocks a write; a malformed SCTID is an
 * audited data-quality warning, exactly like an extensible-binding miss.
 */
import { SYS_SNOMED } from "./systems.js";

// Verhoeff dihedral-group tables (D5), encoded as digit strings so the lookup
// values are not stray magic numbers. d = multiplication, p = permutation.
const D_TABLE = [
  "0123456789",
  "1234067895",
  "2340178956",
  "3401289567",
  "4012395678",
  "5987604321",
  "6598710432",
  "7659821043",
  "8765932104",
  "9876543210"
].map((row) => Array.from(row, Number));

const P_TABLE = [
  "0123456789",
  "1576283094",
  "5809167243",
  "8916043527",
  "9453126870",
  "4286573901",
  "2793806415",
  "7046913258"
].map((row) => Array.from(row, Number));

const SCTID_MIN_DIGITS = 6;
const SCTID_MAX_DIGITS = 18;
const PARTITION_OFFSET_FROM_END = 3;
const RECOGNISED_PARTITION_TYPES = new Set(["0", "1", "2"]);

/** Whether a system URI is the SNOMED CT code system. */
export function isSnomedSystem(system: string): boolean {
  return system === SYS_SNOMED;
}

function verhoeffValid(digits: string): boolean {
  let checksum = 0;
  const reversed = Array.from(digits).reverse();
  for (let index = 0; index < reversed.length; index += 1) {
    const digit = Number(reversed[index]);
    const permuted = P_TABLE[index % P_TABLE.length]?.[digit];
    if (permuted === undefined) return false;
    checksum = D_TABLE[checksum]?.[permuted] ?? -1;
    if (checksum < 0) return false;
  }
  return checksum === 0;
}

function partitionTypeDigit(digits: string): string | undefined {
  return digits.at(-PARTITION_OFFSET_FROM_END);
}

/** Whether a code is a well-formed SCTID (format only — no membership check). */
export function isValidSctid(code: string): boolean {
  if (!/^[0-9]+$/.test(code)) return false;
  if (code.length < SCTID_MIN_DIGITS || code.length > SCTID_MAX_DIGITS) return false;
  if (code.startsWith("0")) return false;
  const partition = partitionTypeDigit(code);
  if (partition === undefined || !RECOGNISED_PARTITION_TYPES.has(partition)) return false;
  return verhoeffValid(code);
}
