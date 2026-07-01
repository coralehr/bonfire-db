/**
 * `loop state <list|set>` — the STATE ledger's CLI face.
 *
 * `list` folds the ledger and merges the slice registry: every slice appears,
 * defaulting to "inbox" when it has no transitions yet. `set` appends one
 * validated transition under the advisory lock. The ledger is the spine the
 * loop reads/writes every run; the agent forgets, the repo remembers.
 */
import { parseArgs } from "node:util";
import { allSlices, getSlice } from "../../contracts/registry.js";
import type { SliceState, StateTransition } from "../../memory/index.js";
import {
  appendTransition,
  currentStates,
  readLedger,
  sliceStateSchema,
  stateLedgerPath
} from "../../memory/index.js";
import { ExitCode } from "../exit-codes.js";
import type { CliIO } from "../io.js";
import { resolveRepoRoot } from "../repo.js";

interface StateValues {
  readonly json: boolean;
  readonly note?: string;
  readonly actor: string;
}

interface SliceRow {
  readonly slice: string;
  readonly state: SliceState;
  readonly ts: string | null;
  readonly actor: string | null;
  readonly note: string | null;
}

function listRows(ledgerPath: string): { rows: SliceRow[]; dropped: number } {
  const { entries, dropped } = readLedger(ledgerPath);
  const latest = currentStates(entries);
  const rows = allSlices().map((slice): SliceRow => {
    const last = latest.get(slice.id);
    return {
      slice: slice.id,
      state: last?.state ?? "inbox",
      ts: last?.ts ?? null,
      actor: last?.actor ?? null,
      note: last?.note ?? null
    };
  });
  return { rows, dropped };
}

function handleList(io: CliIO, ledgerPath: string, json: boolean): number {
  const { rows, dropped } = listRows(ledgerPath);
  if (dropped > 0) {
    io.stderr(`warning: ${String(dropped)} unreadable ledger line(s) dropped (torn write?)\n`);
  }
  if (json) {
    io.stdout(`${JSON.stringify(rows)}\n`);
  } else {
    for (const row of rows) {
      const when = row.ts === null ? "" : `  ${row.ts} by ${row.actor ?? "?"}`;
      io.stderr(`${row.slice}  ${row.state}${when}${row.note === null ? "" : `  (${row.note})`}\n`);
    }
  }
  return ExitCode.OK;
}

function handleSet(
  io: CliIO,
  ledgerPath: string,
  args: { slice: string; state: string; actor: string; note?: string; json: boolean }
): number {
  if (getSlice(args.slice) === undefined) {
    io.stderr(`loop state: unknown slice ${args.slice}\n`);
    return ExitCode.FAILURE;
  }
  const state = sliceStateSchema.safeParse(args.state);
  if (!state.success) {
    io.stderr(`loop state: invalid state "${args.state}" (inbox|active|done|failed)\n`);
    return ExitCode.USAGE;
  }
  const transition: StateTransition = {
    ts: new Date().toISOString(),
    slice: args.slice,
    state: state.data,
    actor: args.actor,
    ...(args.note === undefined ? {} : { note: args.note })
  };
  appendTransition(ledgerPath, transition);
  if (args.json) {
    io.stdout(`${JSON.stringify(transition)}\n`);
  } else {
    io.stderr(`${args.slice} → ${state.data}\n`);
  }
  return ExitCode.OK;
}

export function runStateCommand(io: CliIO, args: readonly string[]): number {
  let values: StateValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      options: {
        json: { type: "boolean", default: false },
        note: { type: "string" },
        actor: { type: "string", default: "cli" }
      },
      allowPositionals: true,
      strict: true
    }));
  } catch (error) {
    io.stderr(`loop state: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.USAGE;
  }

  const repoRoot = resolveRepoRoot(io.cwd);
  if (repoRoot === null) {
    io.stderr("loop state: not inside a git repository\n");
    return ExitCode.USAGE;
  }
  const ledgerPath = stateLedgerPath(repoRoot);
  const [action, slice, state] = positionals;

  switch (action) {
    case "list":
      return handleList(io, ledgerPath, values.json);
    case "set":
      if (slice === undefined || state === undefined) {
        io.stderr(
          "usage: loop state set <slice> <inbox|active|done|failed> [--note <text>] [--actor <name>]\n"
        );
        return ExitCode.USAGE;
      }
      return handleSet(io, ledgerPath, {
        slice,
        state,
        actor: values.actor,
        ...(values.note === undefined ? {} : { note: values.note }),
        json: values.json
      });
    default:
      io.stderr("usage: loop state <list|set> ...\n");
      return ExitCode.USAGE;
  }
}
