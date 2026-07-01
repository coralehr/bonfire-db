import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../gates/exec.js";
import {
  createWorktree,
  isAgentWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  worktreeName,
  worktreePath
} from "./worktree.js";

const OK: CommandResult = { ok: true, exitCode: 0, output: "", spawnError: null };

describe("parseWorktreeList", () => {
  test("parses porcelain blocks into entries", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/bonfire-BF-01-x",
      "HEAD bbbbbbbbbbbb",
      "branch refs/heads/bonfire-BF-01-x",
      ""
    ].join("\n");
    const list = parseWorktreeList(porcelain);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ path: "/repo", head: "aaaaaaaaaaaa", branch: "main" });
    expect(list[1]?.branch).toBe("bonfire-BF-01-x");
  });

  test("a detached HEAD yields branch null", () => {
    const list = parseWorktreeList("worktree /w\nHEAD abc\ndetached\n");
    expect(list[0]?.branch).toBeNull();
  });
});

describe("naming helpers", () => {
  test("worktreeName / worktreePath / isAgentWorktree", () => {
    expect(worktreeName("BF-01", "s")).toBe("bonfire-BF-01-s");
    expect(worktreePath("/r", "BF-01", "s")).toBe("/r/.worktrees/bonfire-BF-01-s");
    expect(isAgentWorktree("/r/.worktrees/bonfire-BF-01-s")).toBe(true);
    expect(isAgentWorktree("/r")).toBe(false);
    // The repo itself may be named bonfire-* — not under .worktrees, so not an agent worktree.
    expect(isAgentWorktree("/home/me/bonfire-db")).toBe(false);
  });
});

describe("git ops through the injected runner", () => {
  test("createWorktree issues the expected git command", () => {
    const calls: string[][] = [];
    const result = createWorktree(
      (argv) => {
        calls.push([...argv]);
        return OK;
      },
      { repoRoot: "/r", slice: "BF-01", session: "s", base: "main" }
    );
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual([
      "git",
      "worktree",
      "add",
      "-b",
      "bonfire-BF-01-s",
      "/r/.worktrees/bonfire-BF-01-s",
      "main"
    ]);
  });

  test("a failed git op surfaces as an err Result carrying the output", () => {
    const failing = (): CommandResult => ({
      ok: false,
      exitCode: 1,
      output: "boom",
      spawnError: null
    });
    const result = removeWorktree(failing, "/r/w");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("boom");
  });

  test("listWorktrees parses a successful porcelain run", () => {
    const list = listWorktrees(() => ({
      ...OK,
      output: "worktree /r\nHEAD abc\nbranch refs/heads/main\n"
    }));
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value[0]?.path).toBe("/r");
  });
});
