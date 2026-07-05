import { describe, expect, test } from "bun:test";
import type { GateReport, GateResult } from "../gates/index.js";
import { ExitCode } from "./exit-codes.js";
import type { CliIO } from "./io.js";
import { main } from "./main.js";
import { renderReportHuman, reportToJson } from "./render.js";

function fakeIO(): { io: CliIO; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    io: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      cwd: process.cwd(),
      env: {}
    }
  };
}

describe("main — dispatch + exit-code contract", () => {
  test("--help prints usage and exits 0", () => {
    const { io, out } = fakeIO();
    expect(main(["--help"], io)).toBe(ExitCode.OK);
    expect(out()).toContain("loop —");
  });

  test("--version exits 0", () => {
    const { io, out } = fakeIO();
    expect(main(["--version"], io)).toBe(ExitCode.OK);
    expect(out()).toContain("loop ");
  });

  test("no args shows help and exits 0", () => {
    const { io } = fakeIO();
    expect(main([], io)).toBe(ExitCode.OK);
  });

  test("an unknown command is a usage error (exit 2)", () => {
    const { io, err } = fakeIO();
    expect(main(["frobnicate"], io)).toBe(ExitCode.USAGE);
    expect(err()).toContain("unknown command");
  });

  test("a bad gate flag is a usage error (exit 2)", () => {
    const { io } = fakeIO();
    expect(main(["gate", "--nope"], io)).toBe(ExitCode.USAGE);
  });

  test("a bad worktree flag is a usage error (exit 2)", () => {
    const { io } = fakeIO();
    expect(main(["worktree", "--nope"], io)).toBe(ExitCode.USAGE);
  });

  test("a bad ratchet flag is a usage error (exit 2)", () => {
    const { io } = fakeIO();
    expect(main(["ratchet", "--nope"], io)).toBe(ExitCode.USAGE);
  });

  test("state without an action is a usage error (exit 2)", () => {
    const { io } = fakeIO();
    expect(main(["state"], io)).toBe(ExitCode.USAGE);
    expect(main(["state", "set", "BF-01"], io)).toBe(ExitCode.USAGE);
  });
});

const FAIL: GateResult = {
  name: "lint",
  stage: 0,
  tier: "blocking",
  status: "fail",
  summary: "lint failed",
  detail: "oops"
};
const REPORT: GateReport = {
  ok: false,
  results: [
    {
      name: "format",
      stage: 0,
      tier: "blocking",
      status: "pass",
      summary: "format passed",
      detail: ""
    },
    FAIL
  ],
  ranStages: [0],
  skippedStages: [1],
  blockingFailures: [FAIL],
  advisoryFailures: [],
  skipped: []
};

describe("render", () => {
  test("human output shows the failing gate and a FAIL verdict", () => {
    const text = renderReportHuman(REPORT);
    expect(text).toContain("✗ lint");
    expect(text).toContain("gate FAIL");
    expect(text).toContain("stage(s) 1 not run");
  });

  test("JSON is a stable machine shape", () => {
    const json = reportToJson(REPORT);
    expect(json.status).toBe("fail");
    expect(json.exitCode).toBe(1);
    expect(json.blockingFailures).toEqual(["lint"]);
  });
});

describe("eval — empty slice filter fails closed", () => {
  test("a slice with zero corpus cases exits 1, never a vacuous pass", () => {
    // BF-13 exists in the registry but owes its eval rows; a verify[] chain
    // running `loop eval --slice BF-13` must go red, not green-on-nothing.
    const { io, err } = fakeIO();
    expect(main(["eval", "--slice", "BF-13"], io)).toBe(ExitCode.FAILURE);
    expect(err()).toContain("no eval cases for slice BF-13");
  });
});
