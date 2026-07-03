# Guard selection — how to close a bug class (harness-author principle)

When a confirmed bug earns a Ratchet guard, the guard TYPE matters as much as the
guard. This principle is written from a concrete lesson (the BF-02 wave): a
denylist regex meant to stop raw-SQL string building was refined twice, spawned a
whole impersonation rule, and an adversarial swarm still bypassed all of it —
because the real control was never the regex.

## Prefer, in order

1. **A structural invariant that makes the bug unrepresentable.** RLS FORCE +
   a non-BYPASSRLS role makes a cross-tenant read return zero rows no matter what
   query is written. A privilege REVOKE makes an append-only table append-only at
   the database, not by hoping code behaves. These hold against code that has not
   been written yet.
2. **A provenance / chokepoint control** — confine the dangerous capability to
   one reviewed place and ban it everywhere else (e.g. `no-raw-postgres-client`
   confines client construction to `packages/core/src/db/**`; `withTenant` is the
   only exported query path; ban a non-literal `.unsafe` argument — the single
   execution sink). Allowlist the one sanctioned form; do not enumerate the
   infinite bad ones.
3. **An execution eval** that asserts observed behavior (zero rows, exit code,
   `jsonb_typeof`, a broken hash chain) — inversion-proof: it goes red if the fix
   is removed.
4. **A denylist pattern (ast-grep / semgrep regex)** — ONLY as defense-in-depth
   on top of 1–3, never as the load-bearing control.

## Test the guard before you trust it

Before recording a guard as `guarded`, ask an adversary (a refutation agent, or
yourself in that mode): *write code that has the bug and passes this guard.* If
you can — and for any denylist you usually can — the guard is defense-in-depth,
not closure. Record what actually holds (the structural control) as the guard,
and note the denylist's residual honestly rather than overclaiming it.

## Smell tests (stop and pick a better guard type)

- The rule is a text regex over a syntax you do not control (SQL inside a
  template, a tag name) → it will false-positive on the safe idiom and miss the
  aliased/typed/extracted evasion. Reach for a structural sink-ban instead.
- You are refining the same regex a second time → the exemption is keyed on the
  wrong thing (a name, a shape). Re-key on provenance, or move the control to the
  sink.
- The guard needs a manual counter bumped on every change → that is ceremony, not
  a guard. Encode the real invariant (does not shrink; the class is present).

Cost discipline cuts both ways: a healthcare-DB tenant/PHI invariant is worth
deep rigor; a slop-shape regex that fights legitimate code usually is not. Guard
the danger classes hard; do not gold-plate the rest.
