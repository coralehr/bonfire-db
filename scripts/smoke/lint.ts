import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
};

const requiredScripts = ["typecheck", "lint", "test", "smoke:demo", "smoke:offline", "scan:synthetic-only"];
const missingScripts = requiredScripts.filter((script) => !packageJson.scripts?.[script]);

if (missingScripts.length > 0) {
  console.error(`lint: missing package scripts: ${missingScripts.join(", ")}`);
  process.exit(1);
}

if (packageJson.engines?.node !== ">=24 <25") {
  console.error("lint: package.json must target Node 24 LTS with engines.node >=24 <25");
  process.exit(1);
}

const compose = readFileSync("docker-compose.yml", "utf8");
const requiredPortBindings = ["127.0.0.1:15432:5432", "127.0.0.1:8080:8080", "127.0.0.1:5173:5173"];
for (const binding of requiredPortBindings) {
  if (!compose.includes(binding)) {
    console.error(`lint: docker-compose.yml must include localhost binding ${binding}`);
    process.exit(1);
  }
}

console.log("lint: PASS");
