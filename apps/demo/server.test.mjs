import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { isInsideRoot, resolvePath } from "./server.mjs";

describe("demo static file resolution", () => {
  test("rejects sibling paths that only share the dist prefix", () => {
    const root = resolve(tmpdir(), "bonfire-demo-dist");
    const sibling = resolve(tmpdir(), "bonfire-demo-dist-evil/index.html");

    expect(isInsideRoot(join(root, "index.html"), root)).toBe(true);
    expect(isInsideRoot(sibling, root)).toBe(false);
  });

  test("falls back to index.html for path traversal attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "bonfire-demo-"));
    mkdirSync(resolve(root, "assets"));
    writeFileSync(resolve(root, "index.html"), "");
    writeFileSync(resolve(root, "assets", "app.js"), "");

    expect(resolvePath("/assets/app.js", root)).toBe(resolve(root, "assets", "app.js"));
    expect(resolvePath("/../bonfire-demo-dist-evil/index.html", root)).toBe(resolve(root, "index.html"));
  });
});
