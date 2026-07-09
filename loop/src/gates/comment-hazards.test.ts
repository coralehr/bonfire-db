/**
 * Ratchet guard BP-032 (comment-terminating-glob): the check:comments lexer gate
 * catches a block comment that ends early because a glob or projection-prefix
 * slash embedded a comment terminator. The script self-tests on every CI run;
 * this pins the exported detector so a weakening (dropping the next-char class,
 * matching inside strings) turns red in the test job too. Positives live as
 * string literals — the scanner is blind to strings, so this file is safe.
 */
import { describe, expect, test } from "bun:test";
import { findCommentHazards } from "../../../scripts/check-comment-hazards.js";

describe("BP-032: block-comment terminator hazard detector", () => {
  test("flags a projection-prefix slash that ends the comment early", () => {
    const incident = ["/**", " * every vd_*/spidx row is rebuilt", " */export const x = 1;"].join(
      "\n"
    );
    expect(findCommentHazards(incident)).toHaveLength(1);
  });

  test("flags a path glob glued onto code", () => {
    expect(findCommentHazards("/** rebuild packages/**/src */function f() {}")).toHaveLength(1);
  });

  test("does not flag a glob inside a string literal or a legitimate close", () => {
    expect(findCommentHazards('const g = "**/*.ts";')).toHaveLength(0);
    expect(findCommentHazards("const q = 'vd_*/spidx';")).toHaveLength(0);
    expect(findCommentHazards("/* ok */\nconst a = 1;")).toHaveLength(0);
    expect(findCommentHazards("/** jsdoc */ 1;")).toHaveLength(0);
  });
});
