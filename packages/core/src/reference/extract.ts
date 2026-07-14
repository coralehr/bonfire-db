import type { JsonObject, JsonValue } from "../db/canonical-json.js";

const RELATIVE_REFERENCE = /^(?<type>[A-Za-z][A-Za-z0-9]*)\/(?<id>[A-Za-z0-9\-.]{1,64})(?:\/_history\/(?<version>[A-Za-z0-9\-.]{1,64}))?$/;

export interface ExplicitReference {
  readonly jsonPath: string;
  readonly targetResourceType: string;
  readonly targetResourceId: string;
  readonly targetVersionId: string | null;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function visit(value: JsonValue, path: readonly string[], output: ExplicitReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visit(item, [...path, String(index)], output);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (key === "reference" && typeof child === "string") {
      const match = RELATIVE_REFERENCE.exec(child);
      if (match?.groups !== undefined) {
        output.push({
          jsonPath: `/${nextPath.map(pointerSegment).join("/")}`,
          targetResourceType: match.groups.type ?? "",
          targetResourceId: match.groups.id ?? "",
          targetVersionId: match.groups.version ?? null
        });
      }
    }
    visit(child, nextPath, output);
  }
}

/** Extract every same-server explicit FHIR Reference from canonical JSON. */
export function extractExplicitReferences(content: JsonObject): readonly ExplicitReference[] {
  const output: ExplicitReference[] = [];
  visit(content, [], output);
  return output.sort((left, right) =>
    [left.jsonPath, left.targetResourceType, left.targetResourceId].join("\u0000").localeCompare(
      [right.jsonPath, right.targetResourceType, right.targetResourceId].join("\u0000")
    )
  );
}
