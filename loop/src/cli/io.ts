/**
 * The injectable I/O seam for the CLI shell.
 *
 * `main(argv, io)` takes its streams, cwd, and env as data so tests drive it
 * in-process with fake sinks and assert on captured output + the returned exit
 * code — no subprocess spawn, coverage intact (research: functional-core /
 * imperative-shell). The real `bin` wires these to the process.
 */
export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}
