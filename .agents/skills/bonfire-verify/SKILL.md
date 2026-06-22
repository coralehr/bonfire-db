---
name: bonfire-verify
description: Verify a Bonfire slice or PR before it can move toward merge. Produces PASS, FAIL, or NEEDS-HUMAN and checks CI, local gates, security posture, and Greptile readiness.
---

# Bonfire Verify

Use this skill as the checker stage of the loop.

1. Read `AGENTS.md`, `docs/loop/ACCEPTANCE.md`, and the slice contract.
2. Inspect the diff against the base branch.
3. Run or request `scripts/loop/verify.sh`.
4. Check whether the security auditor is required. If yes, run it before
   returning PASS.
5. For PRs, check Greptile status. Merge is blocked unless Greptile reports
   `5/5`.

Output:

```text
VERDICT: PASS | FAIL | NEEDS-HUMAN
BLOCKING:
NON-BLOCKING:
GATES:
  CI:
  verify.sh:
  security:
  Greptile:
ACCEPTANCE TRACE:
```
