import { describe, expect, test } from "bun:test";
import { scanTextForViolations } from "./synthetic-only";

describe("synthetic-only scanner", () => {
  test("allows example email domains and synthetic identifiers", () => {
    expect(scanTextForViolations("clinician-blue@example.com SYN-BF-001")).toEqual([]);
  });

  test("flags real-looking email, SSN, DOB, and numeric MRN patterns", () => {
    const violations = scanTextForViolations(
      "alex@realmail.test SSN 123-45-6789 DOB: 01/02/1990 MRN: 123456"
    );

    expect(violations).toContain("non-example-email");
    expect(violations).toContain("ssn");
    expect(violations).toContain("dob");
    expect(violations).toContain("mrn");
  });
});
