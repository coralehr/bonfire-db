import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps", "packages", "scripts/smoke"];
const ignored = new Set(["node_modules", "dist"]);
const suspiciousPatterns = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b[A-Z][a-z]+ [A-Z][a-z]+,?\s+(?:DOB|MRN|SSN)\b/,
  /@(?!example\.com\b|example\.org\b|example\.net\b|localhost\b)[a-z0-9.-]+\.[a-z]{2,}/i
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

for (const file of roots.flatMap((root) => walk(root))) {
  if (!/\.(css|html|json|mjs|ts|tsx|yml|yaml)$/.test(file)) continue;

  const contents = readFileSync(file, "utf8");
  const matched = suspiciousPatterns.find((pattern) => pattern.test(contents));
  if (matched) {
    console.error(`scan:synthetic-only FAIL ${file} matched ${matched}`);
    process.exit(1);
  }
}

console.log("scan:synthetic-only PASS");
