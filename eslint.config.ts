/**
 * Bonfire DB — flat ESLint configuration.
 *
 * Typed linting (the typescript-eslint project service) is mandatory: every
 * rule that needs type information runs against the real program. The bar is
 * deliberately strict — this codebase is built largely by autonomous agents
 * and must resist "AI slop": god files, god functions, obvious comments,
 * orphan task markers, magic numbers, `any`, and silent escape hatches
 * (`eslint-disable`, `@ts-ignore`, `@ts-nocheck`).
 *
 * Layering (later matching entries win):
 *   1. Global ignores.
 *   2. Base: ESLint recommended + eslint-comments, plus plugin-free structural
 *      limits applied to every linted file.
 *   3. TypeScript: strict-type-checked + stylistic-type-checked plus the
 *      Bonfire anti-slop rule set, scoped to TypeScript sources.
 *   4. Config files: relax volume/number limits that do not apply to config.
 *   5. Tests: drop type-aware rules (test files live outside the typed program)
 *      and relax limits that fight readable fixtures.
 *
 * `tsconfigRootDir` is intentionally omitted: typescript-eslint v8 infers it
 * from this file's location, which keeps typed linting correct no matter which
 * directory ESLint is invoked from.
 */
import eslint from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import { defineConfig, globalIgnores } from "eslint/config";
import aiGuardrails from "eslint-plugin-ai-guardrails";
import tseslint from "typescript-eslint";

const MAX_COMPLEXITY = 12;
const MAX_CODE_FILE_LINES = 300;
const MAX_TOTAL_FILE_LINES = 400;
const MAX_FUNCTION_LINES = 50;
const MIN_TS_COMMENT_DESCRIPTION = 10;

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.vite/**",
    "**/*.tsbuildinfo",
    "drizzle/**",
    "**/.gstack/**",
    ".dependency-cruiser.cjs"
  ]),
  {
    name: "bonfire/base",
    extends: [eslint.configs.recommended, comments.recommended],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      // No escape hatches: inline ESLint directive comments are forbidden.
      "@eslint-community/eslint-comments/no-use": "error",
      // Structural anti-slop limits (core rules — safe on every file type).
      complexity: ["error", { max: MAX_COMPLEXITY }],
      "max-lines": [
        "error",
        { max: MAX_TOTAL_FILE_LINES, skipBlankLines: true, skipComments: true }
      ],
      "max-lines-per-function": [
        "error",
        {
          max: MAX_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true
        }
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unreachable": "error",
      // Superseded by the type-aware @typescript-eslint/no-magic-numbers.
      "no-magic-numbers": "off"
    }
  },
  {
    name: "bonfire/typescript",
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.ts"] }
      }
    },
    plugins: { "ai-guardrails": aiGuardrails },
    rules: {
      // --- Hard bans: no `any`, no silent type suppression. ---
      "@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: false }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": true,
          minimumDescriptionLength: MIN_TS_COMMENT_DESCRIPTION
        }
      ],
      // --- Correctness that needs type information. ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true }
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          considerDefaultExhaustiveForUnions: true,
          requireDefaultForNonUnion: true
        }
      ],
      // --- Stable, explicit module surface. ---
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: true
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      // --- Naming: consistent identifiers; external data shapes unconstrained. ---
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "forbid"
        },
        { selector: "import", format: ["camelCase", "PascalCase"] },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow"
        },
        { selector: "function", format: ["camelCase", "PascalCase"] },
        {
          selector: "parameter",
          format: ["camelCase", "PascalCase"],
          leadingUnderscore: "allow"
        },
        { selector: "typeLike", format: ["PascalCase"] },
        {
          selector: "interface",
          format: ["PascalCase"],
          custom: { regex: "^I[A-Z]", match: false }
        },
        { selector: "typeParameter", format: ["PascalCase"] },
        { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
        {
          selector: ["classProperty", "classMethod", "accessor"],
          format: ["camelCase"],
          leadingUnderscore: "allow"
        },
        // DB rows, HTTP headers, and FHIR keys carry external naming.
        { selector: ["objectLiteralProperty", "typeProperty"], format: null }
      ],
      // --- No magic numbers (type-aware variant; core rule is off). ---
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
          enforceConst: true,
          detectObjects: false
        }
      ],
      // --- AI-slop guardrails (file, comment, and task-marker hygiene). ---
      "ai-guardrails/max-file-lines": [
        "error",
        { max: MAX_CODE_FILE_LINES, skipBlankLines: true, skipComments: true }
      ],
      // Advisory: this fights legitimate JSDoc on public APIs (which a
      // world-class library wants and api-extractor consumes). Kept as a signal
      // for genuine narration slop, not a hard block. Revisit thresholds later.
      "ai-guardrails/no-ai-obvious-comments": "warn",
      "ai-guardrails/no-orphan-todos": ["error", { requireReference: true }]
    }
  },
  {
    name: "bonfire/config-files",
    files: ["eslint.config.ts", "**/*.config.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-magic-numbers": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "ai-guardrails/max-file-lines": "off",
      "ai-guardrails/no-ai-obvious-comments": "off"
    }
  },
  {
    name: "bonfire/tests",
    files: [
      "**/*.{test,spec}.{ts,tsx,mts,cts}",
      "**/__tests__/**/*.{ts,tsx}",
      "**/tests/**/*.{ts,tsx}"
    ],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "ai-guardrails/max-file-lines": "off"
    }
  }
);
