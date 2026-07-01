/**
 * The `loop` executable — the ONLY place that touches the real process.
 *
 * Run via `bun run loop/src/cli/bin.ts` (the root `loop` script). Wires the
 * process streams/cwd/env into `main` and exits with its code. Guarded by
 * `import.meta.main` so importing this module has no side effects.
 */
import { main } from "./main.js";

if (import.meta.main) {
  const code = main(process.argv.slice(2), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    cwd: process.cwd(),
    env: process.env
  });
  process.exit(code);
}
