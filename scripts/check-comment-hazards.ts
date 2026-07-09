/**
 * BP-032 guard (comment-terminating-glob): writing a glob or a vd_ prefix + prose
 * slash inside a block comment embeds a star-slash that ENDS the comment early and
 * shreds the file into TS1434 parse errors. No mainstream JS/TS linter checks
 * block-comment BODIES for this (GCC/Clang -Wcomment is the closest prior art),
 * and once the comment closes early the file no longer parses — so AST tools
 * (eslint, ast-grep) are useless on the broken file. This runs at the LEXER level.
 *
 * Approach: lex every tracked TS file with the TypeScript scanner (skipTrivia
 * off). For each MultiLineCommentTrivia token that actually closed (its text ends
 * with the comment terminator), flag when the very next character is an identifier
 * char — that only happens when a comment ended early and code glued straight on;
 * a legitimate close is followed by whitespace, newline, punctuation, or EOF.
 * String and template literals are their own token kinds, so a glob INSIDE a
 * string (the legitimate glob-string occurrences in this repo) is invisible here.
 *
 * Self-test on every run (the mutation canary is built in): the positive fixtures
 * live as STRING LITERALS — safe, because the scanner is blind to strings — so the
 * guard can never trip on its own corpus. If the self-test disagrees, exit 2.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const TS_EXT = /\.(ts|tsx|mts|cts)$/;

export interface CommentHazard {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Flag every block comment that ended early (a closer glued straight onto an identifier char). */
export function findCommentHazards(text: string): { line: number; column: number }[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text
  );
  const hits: { line: number; column: number }[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const tokenText = scanner.getTokenText();
      const end = scanner.getTokenEnd();
      const next = text[end];
      if (tokenText.endsWith("*/") && next !== undefined && IDENT_CHAR.test(next)) {
        const { line, character } = ts.getLineAndCharacterOfPosition(
          ts.createSourceFile("x", text, ts.ScriptTarget.Latest),
          scanner.getTokenStart()
        );
        hits.push({ line: line + 1, column: character + 1 });
      }
    }
    token = scanner.scan();
  }
  return hits;
}

/** The two real incidents (a projection-prefix glob, a path glob) plus known-safe negatives. */
function selfTest(): void {
  // Positives are string literals so the scanner never lexes them as comments.
  const incident = ["/**", " * Every vd_*/spidx row is rebuilt.", " */const x = 1;"].join("\n");
  const globInComment = "/** Rebuild packages/**/src projections. */export const y = 2;";
  const positives = [incident, globInComment];
  for (const src of positives) {
    if (findCommentHazards(src).length !== 1) {
      process.stderr.write(`BP-032 self-test FAILED (positive missed): ${JSON.stringify(src)}\n`);
      process.exit(2);
    }
  }
  const negatives = [
    "/* normal */\nconst a = 1;", // close followed by newline
    "/* inline */ 1;", // close followed by space
    "/** jsdoc */\nfunction f() {}",
    'const g = "**/*.ts";', // glob inside a STRING — legitimate, invisible
    "const p = `src/**/*.ts`;", // glob inside a template
    "const q = 'vd_*/spidx';", // the literal prose inside a string
    "/* trailing at eof */" // close at EOF (next is undefined)
  ];
  for (const src of negatives) {
    if (findCommentHazards(src).length !== 0) {
      process.stderr.write(`BP-032 self-test FAILED (false positive): ${JSON.stringify(src)}\n`);
      process.exit(2);
    }
  }
}

function trackedTsFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  // git ls-files lists tracked paths; a locally deleted-but-unstaged file is
  // still listed but absent on disk — skip it (CI's clean checkout never hits it).
  return out.split("\0").filter((f) => f.length > 0 && TS_EXT.test(f) && existsSync(f));
}

function main(): void {
  selfTest();
  const hazards: CommentHazard[] = [];
  for (const file of trackedTsFiles()) {
    for (const hit of findCommentHazards(readFileSync(file, "utf8"))) {
      hazards.push({ file, ...hit });
    }
  }
  if (hazards.length > 0) {
    for (const h of hazards) {
      process.stderr.write(
        `${h.file}:${String(h.line)}:${String(h.column)} — block comment terminated early by an embedded */ (BP-032); write vd_* + spidx or break the glob (** then /src)\n`
      );
    }
    process.exit(1);
  }
  process.stdout.write(
    `check:comments ok — ${String(trackedTsFiles().length)} TS files, 0 comment-terminator hazards\n`
  );
}

if (import.meta.main) main();
