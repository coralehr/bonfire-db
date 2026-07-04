/**
 * Load the 8 staged scribe ViewDefinitions (packages/sql-on-fhir/
 * viewdefinitions/*.json) through the strict materializable tier. Names must
 * be unique — they become vd_* table names.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { ViewError } from "./errors.js";
import type { MaterializableView } from "./view-definition.js";
import { parseMaterializableView } from "./view-definition.js";

const VIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "viewdefinitions");

/** Parse every staged scribe view (deterministic file-name order). */
export function loadScribeViews(
  viewDir: string = VIEW_DIR
): Result<MaterializableView[], ViewError> {
  const names = readdirSync(viewDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const views: MaterializableView[] = [];
  const seen = new Set<string>();
  for (const fileName of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(viewDir, fileName), "utf8"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err({ code: "VD_INVALID", message: `${fileName} is not JSON: ${message}` });
    }
    const view = parseMaterializableView(raw);
    if (!view.ok) {
      return err({ code: view.error.code, message: `${fileName}: ${view.error.message}` });
    }
    if (seen.has(view.data.name)) {
      return err({ code: "VD_INVALID", message: `duplicate view name '${view.data.name}'` });
    }
    seen.add(view.data.name);
    views.push(view.data);
  }
  return ok(views);
}
