---
name: bonfire-slice
description: Implement one thin Bonfire vertical slice from a locked slice contract. Use for focused build work, not broad planning.
---

# Bonfire Slice

Before editing, read `AGENTS.md` and `docs/loop/ACCEPTANCE.md`.

Input must include a slice contract with `GOAL`, `ALLOWED FILES`,
`FORBIDDEN FILES`, and `ACCEPTANCE`. If any are missing, stop and ask for a
contract instead of guessing.

Implementation rules:

- Keep changes inside `ALLOWED FILES`.
- Add behavior tests with implementation.
- Keep public docs honest about what is real versus roadmap.
- Do not expose raw SQL, arbitrary MCP tools, direct agent writes, real PHI, or
  hosted upload paths.
- Run the relevant verification command before declaring complete.

Output the changed files, verification result, and any remaining blocker.
