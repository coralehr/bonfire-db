const blockedRuntimeKeys = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY"
];

const presentKeys = blockedRuntimeKeys.filter((key) => Boolean(process.env[key]));

if (presentKeys.length > 0) {
  console.error(`smoke:offline FAIL unexpected external runtime keys present: ${presentKeys.join(", ")}`);
  process.exit(1);
}

console.log("smoke:offline PASS zero-key scaffold runtime");
