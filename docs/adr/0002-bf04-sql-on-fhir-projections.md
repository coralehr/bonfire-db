# ADR 0002 — BF-04: SQL-on-FHIR v2 projections (vd_* + spidx)

Status: accepted (BF-04)
Deciders: BF-04 maker, operator prep (see `docs/adr/sql-on-fhir-suite-pin.md`)

## Context

BF-04 adds the typed read surface: a SQL-on-FHIR v2 ViewDefinition runner
(fhirpath.js pinned exactly at 4.10.1) that materializes canonical
`fhir_resources` rows into `vd_<name>` projection tables plus one tall
search-parameter index (`spidx`). One pure engine (`evaluateView`) serves both
the HL7 conformance runner and the Postgres materializer, so the conformance
pass is evidence about the code that writes rows.

## Decisions

### 1. Column type map (LOCKED)

FHIR `decimal` and ALL temporals (`date`, `dateTime`, `instant`, `time`) map
to Postgres `text`, not `numeric`/`timestamptz`:

- `1.50` and `1.5` are distinct FHIR decimals; `numeric` display rules and
  JS `JSON.parse` both erase trailing precision inconsistently.
- Partial dates (`2015`, `2015-02`) are valid FHIR values and unrepresentable
  in `timestamptz` without inventing precision.
- Byte-identical drop+rebuild (the determinism eval) requires a
  representation-stable column; text is the only lossless carrier.

`boolean`→boolean, `integer`/`positiveInt`/`unsignedInt`→integer, all
string-kind primitives→text, complex types and every `collection: true`
column→jsonb (bound via `sql.json`, never a `::jsonb` cast — BP-015).
Known nuance: decimals that exceed JS number precision are normalized at
`JSON.parse` time on the way into `content` (jsonb) — upstream of this slice;
the projection is byte-stable with respect to what canonical storage holds.

### 2. Experimental FHIRPath functions are explicitly disabled

fhirpath@4.10.1 happens to implement `join()`, but `join`/`lowBoundary`/
`highBoundary` are upstream-tagged `experimental` (outside the SQL-on-FHIR
shareable set) and are pinned as declared-unsupported in the suite MANIFEST.
The engine overrides them in the `userInvocationTable` to throw, so the
claimed surface is exactly the shareable set the runner passes 100% of
(133/133; 11 declared-unsupported, printed and counted). This keeps the
allowlist honesty check meaningful: a future fhirpath upgrade cannot silently
grow "conformance"; supporting these later requires editing the pin AND the
manifest allowlist together, which the stale-allowlist check enforces.

### 3. spidx scope cut (v0)

Only the shrunken US Core core for the ~8 scribe resources:

- reference params `subject` / `patient` — the RAW `.reference` string, no
  resolution, no chaining;
- token params `code` / `clinical-status` / `identifier` — (system, code)
  pairs from `CodeableConcept.coding[]` / `Identifier[]`.

Date-range, partial-date, composite, `:text` modifiers and quantity params
are OUT OF SCOPE for v0. The `date_low`/`date_high` columns created by
migration 0004 stay schema-reserved and unwritten. Equality parity with a
canonical JSONB scan is test-enforced per probe (self-generating oracle in
`tests/sql-on-fhir/spidx-parity.test.ts`).

### 4. Ordered-dump mechanism (what actually shipped)

`orderedDumpHash` is the sanctioned fallback from the slice plan: an ordered
`SELECT to_jsonb(row)` (total order via jsonb btree comparison) canonicalized
with the same `canonicalizeJson` the FHIR store uses, then sha256. COPY TO
STDOUT via `.readable()` was not shipped — it adds a stream dependency and
changes nothing about the invariant (hash equality across drop+rebuild);
`timestamptz`/`bigint` round-trip through `to_jsonb` deterministically. The
spidx dump excludes only its synthetic identity column.

### 5. Owner-only DDL, never on a request path

`vd_*` tables are created/dropped ONLY by `rebuildProjections` on the
migration-owner connection handed in by `scripts/sql-on-fhir/rebuild.ts`
(`bun run projections:rebuild`). The runtime `bonfire_app` role cannot DDL.
The in-transaction `upsertProjection` runs entirely on the caller's tenant
transaction handle (DELETE+INSERT, practice_id derived in SQL from the GUC),
computes every row BEFORE the first write, and lets DML failures throw so
`withTenant` rolls canonical + projection + spidx back together (one write
path; proven by `tests/sql-on-fhir/write-atomicity.test.ts`). Wiring
`upsertProjection` into `writeScribeResource` is a disclosed operator edit
(packages/core is off this slice's floor).

### 6. Tenant-scoped primary key — no cross-tenant existence oracle

Every `vd_*` PK is `(practice_id, <key>, row_index)`. A key-equality probe
from another tenant returns zero rows (RLS) and cannot even collide on
insert, so neither read paths nor constraint errors leak that a resource id
exists in another practice. RLS is the verbatim BF-02 template (ENABLE +
FORCE + one permissive policy on the InitPlan `safe_uuid` GUC predicate),
emitted explicitly by the DDL generator; the migration-0004 event trigger is
belt-and-braces, and the catalog-invariant test sweeps every `vd_%`/`spidx%`
relation.

### 7. Conformance allowlist

The declared-unsupported list lives in the vendored-suite MANIFEST
(operator-pinned, see `docs/adr/sql-on-fhir-suite-pin.md`), keyed by
(file, title). The runner executes EVERY case: an undeclared failure fails
the run, an allowlisted case that passes fails the run (stale allowlist), an
allowlist entry matching no case fails the run. There is no other skip state.
