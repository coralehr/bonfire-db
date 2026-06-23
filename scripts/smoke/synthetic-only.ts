import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SyntheticScanViolation {
  file: string;
  rule: string;
}

export const defaultRoots = ["apps", "packages", "scripts/smoke", "scripts/seed", "seed", "drizzle"];
const ignored = new Set(["node_modules", "dist"]);
const scannableFilePattern = /\.(css|html|json|mjs|sql|ts|tsx|txt|yml|yaml)$/;

export const suspiciousPatterns = [
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/
  },
  {
    name: "dob",
    pattern: /\b(?:DOB|date of birth)\s*[:=]?\s*(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/i
  },
  {
    name: "mrn",
    pattern: /\bMRN\s*[:#-]?\s*\d{5,}\b/i
  },
  {
    name: "named-phi-label",
    pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+,?\s+(?:DOB|MRN|SSN)\b/
  },
  {
    name: "non-example-email",
    pattern: /[\w.+-]+@(?!example\.com\b|example\.org\b|example\.net\b|localhost\b)[a-z0-9.-]+\.[a-z]{2,}/i
  }
];

function walk(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  return readdirSync(path).flatMap((entry) => {
    if (ignored.has(entry)) return [];
    return walk(join(path, entry));
  });
}

export function scanTextForViolations(contents: string): string[] {
  return suspiciousPatterns
    .filter(({ pattern }) => pattern.test(contents))
    .map(({ name }) => name);
}

export function findSyntheticScanViolations(roots = defaultRoots): SyntheticScanViolation[] {
  const violations: SyntheticScanViolation[] = [];

  for (const file of roots.flatMap((root) => walk(root))) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".test.mjs")) continue;
    if (!scannableFilePattern.test(file)) continue;

    const contents = readFileSync(file, "utf8");
    for (const rule of scanTextForViolations(contents)) {
      violations.push({ file, rule });
    }
  }

  return violations;
}

function main(): void {
  const violations = findSyntheticScanViolations();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`scan:synthetic-only FAIL ${violation.file} matched ${violation.rule}`);
    }
    process.exit(1);
  }

  console.log("scan:synthetic-only PASS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
