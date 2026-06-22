# Bonfire DB MVP Demo Plan

Status: locked for first build loop.

Purpose: build an open-source credibility artifact for indie developers and
startups building AI-health products. A technical founder should be able to
clone the repo, run one command, inspect the code, and decide that Bonfire is
serious enough to try, contribute to, or discuss as an early design partner.

## Summary

Bonfire v0 is a local-first clinical backend demo. It proves the smallest
valuable thesis:

- cited semantic search over synthetic clinical data
- one visible ABAC + consent gate
- append-only hash-chained audit
- propose-only agent writes
- FHIR R4 export/import round-trip
- typed SDK surface for builders

The demo is not production, not HIPAA-complete, and not the cloud product. It is
the open-source self-host/free-dev tier embryo.

## ICP

Primary users:

- indie developers building AI scribes, intake agents, care copilots, referral
  agents, prior-auth helpers, and patient-data assistants
- startup founders choosing between raw Postgres, Supabase, Medplum, Aidbox,
  HealthLake, or hand-rolled FHIR
- top OSS engineers who will judge the project by code quality, honesty, tests,
  and contributor ergonomics

The demo should earn a call, not close the whole sale.

## Product Wedge

The winning workflow:

```text
synthetic transcript
  -> agent proposes a structured note
  -> clinician approves
  -> note becomes searchable with citations
  -> wrong clinician is denied by policy
  -> audit ledger proves the gate fired
  -> note exports and imports as FHIR R4
```

This is narrow enough to ship and concrete enough for scribe/care-copilot
founders to recognize as their real backend problem.

## Stack

- Package manager and scripts: Bun
- Runtime target: Node 24 LTS compatibility
- Language: TypeScript strict
- API: Fastify
- UI: Vite + React
- Validation: Zod 4
- Database: Postgres 18 + pgvector
- Migrations: Drizzle generated SQL, committed
- Embeddings: committed precomputed vectors first; local runtime embeddings are
  optional
- FHIR boundary: R4 document Bundle with Composition first
- MCP: local-only, fixed tools derived from typed functions
- CI: GitHub Actions
- Review gate: Greptile `5/5` required before merge

Do not write Bun-only runtime code unless there is a measured reason. The repo
should remain Node-compatible for contributors and deployment portability.

## Demo Beats

### 1. Boot

Command:

```bash
git clone https://github.com/ticvision/bonfire-db
cd bonfire-db
docker compose up
```

Rules:

- no API keys
- synthetic data only
- localhost-only ports
- visible progress logs for migrate, seed, embeddings, API, and UI readiness
- first boot time measured and documented honestly

### 2. Cited Search

Actor: seeded Clinician.

Query example:

```text
Which of my patients reported suicidal ideation this week?
```

Result must include:

- deterministic templated summary
- citations with note id, Patient id, timestamp, and snippet
- freshness object
- `excludedByPolicy`
- policy receipt
- audit event id

No generative model runs in v0.

### 3. ABAC Denial And Audit

Switch to a Clinician without consent/roster access and rerun the same query.

Result:

- SDK throws `BonfireAccessDenied`
- UI renders policy-as-data
- audit ledger appends a denied event
- hash chain remains valid

Policy model:

```text
allow when:
  actor.kind = Clinician
  actor.practiceId = patient.practiceId
  patient is in actor roster
  consent is active
  purposeOfUse = TREATMENT
  scope includes read clinical data
```

### 4. Propose-Only Note

Actor: seeded agent.

Flow:

```text
proposeNote(transcript)
  -> DraftNote
  -> agent approve attempt denied and audited
  -> Clinician approveNote(draftId)
  -> Note committed
```

The draft body is deterministic over the synthetic transcript fixture. It is not
LLM-generated.

### 5. FHIR Export/Import

Flow:

```text
exportFHIR(noteId)
  -> R4 Bundle(type=document)
  -> Composition first
  -> all references resolve
  -> importBundle(bundle)
  -> imported Note is searchable and cited
```

Claim only "R4 document-bundle invariant checked" unless a full validator is
actually added.

## Public API

SDK shape:

```ts
const bonfire = new Bonfire({
  baseUrl: "http://localhost:8080",
  actorId: "clinician-alvarez",
  purposeOfUse: "TREATMENT",
});

await bonfire.semanticSearch({ query, topK: 8 });
await bonfire.terminology.validate({ system, code });
await bonfire.proposeNote({ patientId, transcript, noteType: "DAP" });
await bonfire.approveNote({ draftId });
await bonfire.exportFHIR({ noteId });
await bonfire.importBundle({ bundle, mode: "roundtrip-demo" });
await bonfire.loadDocument({ patientId, title, text });
await bonfire.audit.tail({ limit: 20 });
```

HTTP endpoints mirror the SDK:

- `POST /search`
- `POST /terminology/validate`
- `POST /notes/propose`
- `POST /notes/approve`
- `GET /notes/:id/fhir`
- `POST /fhir/import`
- `POST /documents/load`
- `GET /audit/tail`
- `GET /health`

Local MCP tools:

- `bonfire.semantic_search`
- `bonfire.terminology_validate`
- `bonfire.propose_note`
- `bonfire.export_fhir`
- `bonfire.audit_tail`

Do not expose:

- raw SQL
- shell
- file access
- arbitrary tool execution
- direct approve/write tool
- remote hosted MCP in v0

## Data Model

Minimum tables:

- `practices`
- `actors`
- `patients`
- `patient_roster`
- `consents`
- `notes`
- `note_chunks`
- `note_embeddings`
- `draft_notes`
- `terminology_codes`
- `fhir_imports`
- `audit_events`
- `seed_state`

Hard invariants:

- every clinical row has `practice_id`
- every Patient belongs to exactly one Practice
- search is scoped before retrieval output is returned
- embeddings are treated as clinical data
- `audit_events` is append-only
- `audit_events` has `prev_hash` and `row_hash`
- seed is idempotent and records `seed_complete`

## Repo Layout

Target layout:

```text
bonfire-db/
  AGENTS.md
  README.md
  SECURITY.md
  CONTRIBUTING.md
  docker-compose.yml
  Dockerfile
  bun.lock
  package.json
  docs/
    loop/
    plans/
    architecture.md
    compliance-posture.md
    abac-model.md
    whats-real-vs-design.md
  packages/
    core/
    sdk/
    mcp/
  apps/
    api/
    demo/
  seed/
    data.ts
    embeddings.bin
    transcript.txt
    valueset.json
  scripts/
    loop/
    seed/
    smoke/
```

## Loop Slice Order

The harness builds in this order:

1. Harness skeleton and CI.
2. Bun workspace, Docker compose, Postgres + pgvector boot.
3. Drizzle schema, migrations, seed, synthetic-only scanner.
4. ABAC gate and hash-chained audit.
5. Cited semantic search.
6. Demo UI search beat.
7. Denial and audit UI beat.
8. Propose-only note.
9. FHIR export/import.
10. Local MCP tools.
11. README, GIF, docs, hosted read-only playground.

Each slice opens as a draft PR and must pass:

- CI
- `scripts/loop/verify.sh`
- Bonfire verifier
- security auditor when applicable
- Greptile `5/5`
- human final review

## Test Plan

Unit tests:

- Zod schemas accept valid input and reject invalid input
- terminology validate/search behavior
- policy allow/deny branches
- hash-chain calculation
- deterministic summary templates
- FHIR bundle construction

Database tests:

- migrations run from empty DB
- seed is idempotent
- `audit_events` update/delete fails
- hash-chain tamper is detected
- no search result crosses Practice boundary

Integration tests:

- SDK calls API
- API gates search before returning results
- denied access creates audit event
- propose-only agent cannot approve
- Clinician can approve
- exported bundle imports back

Browser tests:

- boot page shows ready state
- cited search beat works
- actor switch shows denial
- audit rail updates
- transcript propose/approve works
- FHIR export/import panel works

Security tests:

- synthetic-only scanner fails on real-looking PHI
- no secrets in fixtures/docs
- no raw SQL or unsafe MCP tools exposed
- logs avoid patient-identifiable content

Offline smoke:

- built runtime completes scripted demo after network is disabled
- if live embeddings are unavailable, scripted precomputed vectors still work

## Not In Scope

- production cloud infra
- RDS, ECS, SQS, Cognito, KMS, Bedrock
- Rust data plane
- real PHI
- BAA-hosted production
- real OAuth or SMART-on-FHIR
- full FHIR server
- full terminology server
- MIMIC benchmark
- cohort analytics or k-anonymity
- hybrid RRF search
- offline sync or CRDTs
- remote hosted MCP
- autonomous agent writes
- billing

## Done When

- clean clone boots locally
- five demo beats work in browser
- SDK snippet works against local API
- zero-key runtime
- synthetic-only CI tripwire green
- README has demo GIF, architecture, quickstart, and honest status table
- Greptile gives the final PR `5/5`
- at least one technical founder can run it and understand the value without a
  live walkthrough

## CTA

Primary CTA:

```text
Give us one painful AI-health workflow. We will map it into Bonfire in 48 hours.
If it works, become a design partner.
```

Pricing is not part of the demo UI. It can live in outreach and design-partner
conversations.
