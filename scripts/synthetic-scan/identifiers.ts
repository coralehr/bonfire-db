/**
 * Pure structural validators for US healthcare identifiers.
 *
 * The scanner INVERTS the usual check: the repo convention is that synthetic
 * fixtures carry identifiers that are invalid by construction, so a
 * STRUCTURALLY VALID identifier is the anomaly worth flagging.
 */

const SSN_PATTERN = /^(\d{3})-(\d{2})-(\d{4})$/;
const SSN_AREA_ZERO = "000";
const SSN_AREA_666 = "666";
const SSN_AREA_HIGH_MIN = 900;
const SSN_GROUP_ZERO = "00";
const SSN_SERIAL_ZERO = "0000";

/** Post-2011 SSA randomization rules: area 000/666/900-999, group 00, serial 0000 are never issued. */
export function isStructurallyValidSsn(value: string): boolean {
  const match = SSN_PATTERN.exec(value.trim());
  if (match === null) return false;
  const [, area, group, serial] = match;
  if (area === undefined || group === undefined || serial === undefined) return false;
  if (area === SSN_AREA_ZERO || area === SSN_AREA_666) return false;
  if (Number(area) >= SSN_AREA_HIGH_MIN) return false;
  if (group === SSN_GROUP_ZERO) return false;
  if (serial === SSN_SERIAL_ZERO) return false;
  return true;
}

const NANP_LENGTH = 10;
const NANP_WITH_COUNTRY_CODE = 11;
const NANP_EXCHANGE_INDEX = 3;
const NANP_LINE_INDEX = 6;
const FICTIONAL_EXCHANGE = "555";
const FICTIONAL_LINE_PREFIX = "01";

function nanpDigits(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits.length === NANP_LENGTH) return digits;
  if (digits.length === NANP_WITH_COUNTRY_CODE && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return undefined;
}

/** True for a well-formed 10-digit NANP number (area/exchange start 2-9). */
export function isNanpValidPhone(value: string): boolean {
  const digits = nanpDigits(value);
  if (digits === undefined) return false;
  const area = digits.charAt(0);
  const exchange = digits.charAt(NANP_EXCHANGE_INDEX);
  return area >= "2" && area <= "9" && exchange >= "2" && exchange <= "9";
}

/** True when the number sits in the reserved fictional range 555-0100..0199. */
export function isFictionalPhone(value: string): boolean {
  const digits = nanpDigits(value);
  if (digits === undefined) return false;
  const exchange = digits.slice(NANP_EXCHANGE_INDEX, NANP_LINE_INDEX);
  const line = digits.slice(NANP_LINE_INDEX);
  return exchange === FICTIONAL_EXCHANGE && line.startsWith(FICTIONAL_LINE_PREFIX);
}

const NPI_PATTERN = /^\d{10}$/;
const NPI_LUHN_PREFIX = "80840";
const LUHN_MOD = 10;
const LUHN_DOUBLE_EXCESS = 9;

/** CMS NPI check digit: Luhn over the 80840-prefixed 15-digit string. */
export function isLuhnValidNpi(value: string): boolean {
  const digits = value.trim();
  if (!NPI_PATTERN.test(digits)) return false;
  const full = `${NPI_LUHN_PREFIX}${digits}`;
  let sum = 0;
  let doubleIt = false;
  for (let i = full.length - 1; i >= 0; i -= 1) {
    let digit = Number(full.charAt(i));
    if (doubleIt) {
      digit *= 2;
      if (digit > LUHN_DOUBLE_EXCESS) digit -= LUHN_DOUBLE_EXCESS;
    }
    sum += digit;
    doubleIt = !doubleIt;
  }
  return sum % LUHN_MOD === 0;
}

const DOB_PATTERN = /^(\d{4})-\d{2}-\d{2}$/;
const DOB_MIN_YEAR = 1900;

/** Weak signal: a birthDate that could belong to a living person. */
export function isPlausibleBirthDate(value: string): boolean {
  const match = DOB_PATTERN.exec(value.trim());
  if (match === null) return false;
  const year = Number(match[1]);
  return year >= DOB_MIN_YEAR && year <= new Date().getFullYear();
}
