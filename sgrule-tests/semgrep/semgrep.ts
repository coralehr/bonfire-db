// Behaviour corpus for the root semgrep.yml rules (ratchet BP-011, BP-015).
// Run: semgrep scan --test sgrule-tests/semgrep   (the sibling semgrep.yml is a
// symlink to the root config, so this corpus always tests the LIVE rules).
// `ruleid:` marks a line the named rule MUST flag; `ok:` marks one it must not.
// The gate fails if any annotation disagrees with the scan — deleting this
// file reopens BP-011 (the ratchet guard ref points here).
declare const sql: {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  json(value: unknown): unknown;
  unsafe(text: string): Promise<unknown>;
};
declare const mysql: (strings: TemplateStringsArray, ...values: unknown[]) => string;
declare const db: { unsafe(text: string): Promise<unknown> };
declare const practiceId: string;
declare const label: string;
declare const context: string;
declare const content: object;

export async function sanctionedTaggedTemplates(): Promise<void> {
  // ok: bonfire-mcp-tool-raw-sql-concat
  await sql`select id, content from fhir_resources where practice_id = ${practiceId}`;
  // ok: bonfire-mcp-tool-raw-sql-concat
  await sql`update rls_scaffold set label = ${label} where practice_id = ${practiceId}`;
  // ok: bonfire-mcp-tool-raw-sql-concat
  await sql`select set_config('app.current_practice_id', ${practiceId}, true)`;
  // ok: bonfire-jsonb-stringify-double-encode
  await sql`insert into t (c) values (${sql.json(content)})`;
}

export function proseTemplatesAreNotSql(): string {
  // The tenant.ts regression: prose mentioning "from"/"where" plus ${} is not
  // a SQL statement and must not be flagged.
  // ok: bonfire-mcp-tool-raw-sql-concat
  return `unexpected row shape from ${context}`;
}

export async function bannedShapes(): Promise<void> {
  // ruleid: bonfire-mcp-tool-raw-sql-concat
  const untagged = `select * from fhir_resources where practice_id = ${practiceId}`;
  // ruleid: bonfire-mcp-tool-raw-sql-concat
  const nearMissTag = mysql`select * from write_inputs where id = ${practiceId}`;
  // ruleid: bonfire-mcp-tool-raw-sql-concat
  const concatenated = "select * from history where id = " + practiceId;
  // ruleid: bonfire-sql-injection-string-build, bonfire-mcp-tool-raw-sql-concat
  await db.unsafe(`select * from t where id = ${practiceId}`);
  // ruleid: bonfire-jsonb-stringify-double-encode
  await sql`insert into t (c) values (${JSON.stringify(content)}::jsonb)`;
  const serialized = JSON.stringify(content);
  // ruleid: bonfire-jsonb-stringify-double-encode
  await sql`insert into t (c) values (${serialized}::jsonb)`;
  // ruleid: bonfire-jsonb-stringify-double-encode
  await sql`insert into t (c) values (cast(${JSON.stringify(content)} as jsonb))`;
  void untagged;
  void nearMissTag;
  void concatenated;
}
