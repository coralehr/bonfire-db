// @ts-check
/**
 * dependency-cruiser — machine-enforced module boundaries for the bonfireDB monorepo.
 *
 * These rules ARE the architecture, encoded. They are not advisory: every rule below has
 * `severity: "error"`, so a violation fails the gate (CI + local lint). This is an explicitly
 * anti-"AI slop" codebase — boundaries that live only in prose rot; boundaries a tool checks on
 * every commit stay true.
 *
 * Two codebases share one repo, and the firewall between them is absolute:
 *
 *   THE PRODUCT (shipped):                                THE HARNESS (builds the product):
 *     apps/*  ─▶ packages/sdk ─▶ packages/core ◀─ packages/mcp      loop/*  ─▶ loop/* only
 *                                  ▲
 *                            (the foundation)
 *
 *   • Dependencies flow ONE WAY, toward `core`. No back-edges, no cycles.
 *   • `loop/**` (the harness) may import `loop/**` ONLY. It exercises the product as an
 *     external subprocess; it never links against product code.
 *   • The product (and its workspace glue) must NEVER import `loop/**`. Shipping code is fully
 *     independent of the tooling that generated it.
 *   • Every workspace package is consumed through its public entry point
 *     (`@bonfire/<name>` → `packages/<name>/src/index.ts`). Reaching into another package's
 *     `src/` internals is forbidden, so the public API stays the only contract consumers can
 *     couple to.
 *
 * Source of truth for this topology: docs/plans/loop-harness-plan.md (section 2).
 * Module resolution honours tsconfig.base.json `paths` and the workspaces' `exports`, and
 * follows type-only edges (`tsPreCompilationDeps`), so an `import type` cannot smuggle a banned
 * edge past the checker.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    // ---------------------------------------------------------------------------------------
    // The harness <-> product firewall (the most important boundary in the repo).
    // ---------------------------------------------------------------------------------------
    {
      name: "harness-must-not-import-product",
      severity: "error",
      comment:
        "The loop harness (loop/**) is a separate codebase. It may import loop/** only — never " +
        "the product or its glue (packages/**, apps/**, drizzle/**, seed/**, scripts/**). The " +
        "harness runs the product as an external subprocess; it does not link against it. See " +
        "docs/plans/loop-harness-plan.md section 2.",
      from: { path: "^loop/" },
      to: {
        path: "^(packages|apps|drizzle|seed|scripts)/",
        // Self-edges within loop/** are the whole point and are always allowed.
        pathNot: "^loop/"
      }
    },
    {
      name: "product-must-not-import-harness",
      severity: "error",
      comment:
        "The product and its workspace glue (packages/**, apps/**, drizzle/**, seed/**, " +
        "scripts/**) must never import the loop harness (loop/**). Shipping code is fully " +
        "independent of the tooling that builds it.",
      from: { path: "^(packages|apps|drizzle|seed|scripts)/" },
      to: { path: "^loop/" }
    },

    // ---------------------------------------------------------------------------------------
    // One-way product layering: apps/* -> packages/sdk -> packages/core <- packages/mcp.
    // ---------------------------------------------------------------------------------------
    {
      name: "core-is-foundational",
      severity: "error",
      comment:
        "packages/core is the foundation of the product graph. Dependencies flow toward core, " +
        "never out of it: core must not depend on sdk, mcp, or apps.",
      from: { path: "^packages/core/" },
      to: { path: "^(packages/(sdk|mcp)|apps)/" }
    },
    {
      name: "sdk-depends-only-on-core",
      severity: "error",
      comment:
        "packages/sdk may depend on packages/core only. It must not reach into mcp or apps " +
        "(one-way chain: apps -> sdk -> core).",
      from: { path: "^packages/sdk/" },
      to: { path: "^(packages/mcp|apps)/" }
    },
    {
      name: "mcp-depends-only-on-core",
      severity: "error",
      comment:
        "packages/mcp may depend on packages/core only. It must not reach into sdk or apps " +
        "(one-way: mcp -> core).",
      from: { path: "^packages/mcp/" },
      to: { path: "^(packages/sdk|apps)/" }
    },
    {
      name: "apps-do-not-cross-import",
      severity: "error",
      comment:
        "Apps are leaf nodes of the product graph. One app must not import another app — share " +
        "code through packages/* (sdk/core/mcp) instead. ($1 is the importing app's directory.)",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/[^/]+/", pathNot: "^apps/$1/" }
    },

    // ---------------------------------------------------------------------------------------
    // Public API discipline: consume packages through their entry point, not their internals.
    // ---------------------------------------------------------------------------------------
    {
      name: "packages-consumed-via-public-entry",
      severity: "error",
      comment:
        "A package may use its own internals, but must consume any OTHER @bonfire/* package " +
        "through its public entry point (packages/<name>/src/index.ts) — never by reaching into " +
        "its src/ internals. ($1 is the importing package's directory.)",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: [
          "^packages/$1/", // own-package internals are fine
          "^packages/[^/]+/src/index\\.ts$" // the public entry point is fine
        ]
      }
    },
    {
      name: "consumers-use-package-entry-points",
      severity: "error",
      comment:
        "Apps and workspace glue (drizzle/seed/scripts) must import @bonfire/* packages through " +
        "their public entry point (packages/<name>/src/index.ts) only — no deep imports into " +
        "src/ internals.",
      from: { path: "^(apps|drizzle|seed|scripts)/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: "^packages/[^/]+/src/index\\.ts$"
      }
    },

    // ---------------------------------------------------------------------------------------
    // Universal structural invariants.
    // ---------------------------------------------------------------------------------------
    {
      name: "no-circular",
      severity: "error",
      comment:
        "No circular dependencies. Cycles defeat composite project references, make modules " +
        "impossible to reason about in isolation, and are a leading indicator of tangled design.",
      from: {},
      to: { circular: true }
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment:
        "Every import must resolve. An unresolvable module is a typo, a missing dependency, or a " +
        "broken path alias — all bugs, never intentional.",
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: "no-orphans",
      severity: "error",
      comment:
        "No orphan modules — files nothing imports and that import nothing are dead weight. " +
        "Genuine standalone entry points (servers, app/library/CLI entries), declaration files, " +
        "tool configs, test/spec files, and operational glue (scripts/seed/drizzle) are exempt.",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$", // type declarations (incl. *-env.d.ts)
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|cts|mts)$", // dotfile configs (.eslintrc.cjs, ...)
          "(^|/)tsconfig[^/]*\\.json$", // tsconfig.json / tsconfig.*.json
          "\\.config\\.(js|cjs|mjs|ts|cts|mts)$", // *.config.ts/js (vite, vitest, drizzle, ...)
          "\\.(test|spec)\\.(js|cjs|mjs|ts|cts|mts|jsx|tsx)$", // tests are run, not imported
          "(^|/)(server|main|index)\\.(js|cjs|mjs|ts|cts|mts|jsx|tsx)$", // entry points
          "^loop/cli/", // CLI commands are invoked by name, not imported
          "^(scripts|seed|drizzle)/" // operational glue run as entry points
        ]
      },
      to: {}
    }
  ],

  options: {
    /**
     * Analyse source only. node_modules is left as opaque leaves; built output, coverage, and
     * caches never carry meaningful boundary information.
     */
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(apps|packages|loop|drizzle|seed|scripts)/",
    exclude: { path: "(^|/)(dist|build|coverage|\\.cache|node_modules)/" },

    /**
     * Follow type-only dependencies so `import type { X } from '@bonfire/sdk'` inside core is
     * caught as a back-edge just like a value import would be. Resolution uses the root path
     * map (`@bonfire/*` -> `packages/<pkg>/src`) from tsconfig.base.json.
     */
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },

    /**
     * Resolve the workspaces' `exports` maps against source. The `bun` condition is listed first
     * (matching each package.json's `exports`) so `@bonfire/*` resolves to `./src/index.ts`
     * rather than `./dist/index.js`, keeping the analysed graph in TypeScript source.
     */
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      conditionNames: ["bun", "import", "require", "node", "types", "default"],
      mainFields: ["module", "main", "types", "typings"],
      exportsFields: ["exports"]
    },

    /**
     * Cache results (keyed off git metadata) under node_modules/.cache/dependency-cruiser, which
     * is gitignored. Keeps repeat local runs fast without risking stale results in CI.
     */
    cache: { strategy: "metadata", compress: true },

    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)"
      },
      archi: {
        collapsePattern:
          "^(?:packages|apps|loop)/[^/]+|^(?:drizzle|seed|scripts)|^node_modules/(?:@[^/]+/[^/]+|[^/]+)"
      },
      text: { highlightFocused: true }
    }
  }
};
