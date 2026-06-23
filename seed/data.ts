import { seedCompleteKey as sharedSeedCompleteKey } from "../packages/core/src/schema.js";

export const seedVersion = "BF-02.1";
export const seedCompleteKey = sharedSeedCompleteKey;
export const zeroHash = "0".repeat(64);

const practiceId = "11111111-1111-4111-8111-111111111111";
const clinicianId = "22222222-2222-4222-8222-222222222201";
const agentId = "22222222-2222-4222-8222-222222222202";
const emberPatientId = "33333333-3333-4333-8333-333333333301";
const harborPatientId = "33333333-3333-4333-8333-333333333302";
const emberNoteId = "44444444-4444-4444-8444-444444444401";
const harborNoteId = "44444444-4444-4444-8444-444444444402";
const emberChunkId = "55555555-5555-4555-8555-555555555501";
const harborChunkId = "55555555-5555-4555-8555-555555555502";

export const bonfireSeed = {
  practices: [
    {
      id: practiceId,
      slug: "northstar-demo",
      name: "Northstar Synthetic Care"
    }
  ],
  actors: [
    {
      id: clinicianId,
      practiceId,
      role: "clinician",
      displayName: "Clinician Blue",
      email: "clinician-blue@example.com"
    },
    {
      id: agentId,
      practiceId,
      role: "agent",
      displayName: "Bonfire Local Agent",
      email: "bonfire-agent@example.com"
    }
  ],
  patients: [
    {
      id: emberPatientId,
      practiceId,
      syntheticMrn: "SYN-BF-001",
      displayName: "Synthetic Patient Ember",
      birthYear: 1991
    },
    {
      id: harborPatientId,
      practiceId,
      syntheticMrn: "SYN-BF-002",
      displayName: "Synthetic Patient Harbor",
      birthYear: 1987
    }
  ],
  patientRoster: [
    {
      practiceId,
      actorId: clinicianId,
      patientId: emberPatientId,
      relationship: "primary_clinician"
    },
    {
      practiceId,
      actorId: clinicianId,
      patientId: harborPatientId,
      relationship: "primary_clinician"
    }
  ],
  consents: [
    {
      id: "66666666-6666-4666-8666-666666666601",
      practiceId,
      patientId: emberPatientId,
      scope: "demo-treatment",
      status: "active",
      recordedAt: "2026-01-05T00:00:00.000Z"
    },
    {
      id: "66666666-6666-4666-8666-666666666602",
      practiceId,
      patientId: harborPatientId,
      scope: "demo-treatment",
      status: "active",
      recordedAt: "2026-01-05T00:00:00.000Z"
    }
  ],
  notes: [
    {
      id: emberNoteId,
      practiceId,
      patientId: emberPatientId,
      authorActorId: clinicianId,
      noteType: "DAP",
      status: "signed",
      body: "Synthetic visit note: Patient Ember described a difficult week, denied a current plan, and agreed to a same-week follow-up."
    },
    {
      id: harborNoteId,
      practiceId,
      patientId: harborPatientId,
      authorActorId: clinicianId,
      noteType: "DAP",
      status: "signed",
      body: "Synthetic visit note: Patient Harbor reported improved sleep and completed a check-in plan."
    }
  ],
  noteChunks: [
    {
      id: emberChunkId,
      practiceId,
      noteId: emberNoteId,
      chunkIndex: 0,
      content: "Patient Ember described distress, denied a current plan, and agreed to a follow-up."
    },
    {
      id: harborChunkId,
      practiceId,
      noteId: harborNoteId,
      chunkIndex: 0,
      content: "Patient Harbor reported improved sleep and completed a check-in plan."
    }
  ],
  embeddings: [
    {
      id: "77777777-7777-4777-8777-777777777701",
      practiceId,
      noteChunkId: emberChunkId,
      fixtureKey: "ember-risk-note-v1",
      embeddingModel: "bonfire-local-fixture-v1",
      vector: [0.12, 0.04, 0.88, 0.31, 0.22, 0.09, 0.44, 0.51]
    },
    {
      id: "77777777-7777-4777-8777-777777777702",
      practiceId,
      noteChunkId: harborChunkId,
      fixtureKey: "harbor-sleep-note-v1",
      embeddingModel: "bonfire-local-fixture-v1",
      vector: [0.07, 0.62, 0.18, 0.27, 0.54, 0.33, 0.11, 0.29]
    }
  ],
  draftNotes: [
    {
      id: "88888888-8888-4888-8888-888888888801",
      practiceId,
      patientId: emberPatientId,
      proposerActorId: agentId,
      noteType: "DAP",
      proposedText: "Synthetic proposed note awaiting clinician approval.",
      status: "proposed"
    }
  ],
  terminologyCodes: [
    {
      id: "99999999-9999-4999-8999-999999999901",
      practiceId,
      codeSystem: "bonfire-demo",
      code: "SYN-RISK-FOLLOWUP",
      display: "Synthetic follow-up risk marker"
    }
  ],
  fhirImports: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      practiceId,
      patientId: emberPatientId,
      bundleType: "document-placeholder",
      bundleHash: "bf02-synthetic-fhir-placeholder",
      sourceLabel: "bf02-seed-placeholder",
      importedAt: "2026-01-05T00:00:00.000Z"
    }
  ],
  auditEvents: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      practiceId,
      actorId: clinicianId,
      action: "seed.load",
      targetType: "seed_state",
      targetId: seedCompleteKey,
      decision: "allow",
      reason: "BF-02 deterministic seed",
      prevHash: zeroHash,
      seedKey: "bf02-seed-load"
    }
  ]
} as const;

export function seedEmails(): string[] {
  return bonfireSeed.actors.map((actor) => actor.email);
}
