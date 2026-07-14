export const REFERENCE_PROFILE_NAMES = ["micro-evidence-v1", "clinical-reference-v1"] as const;
export type ReferenceProfileName = (typeof REFERENCE_PROFILE_NAMES)[number];

export type ReferenceEvidenceStatus = "measured-exploratory" | "experimental-unvalidated";

export interface ReferenceRule {
  readonly sourceType: string;
  readonly pathFamily: string;
  readonly pointerPattern: RegExp;
  readonly targetTypes: readonly string[];
}

export interface ReferenceProfile {
  readonly name: ReferenceProfileName;
  readonly evidenceStatus: ReferenceEvidenceStatus;
  readonly rules: readonly ReferenceRule[];
}

function rule(
  sourceType: string,
  pathFamily: string,
  pointerPattern: RegExp,
  ...targetTypes: string[]
): ReferenceRule {
  return { sourceType, pathFamily, pointerPattern, targetTypes };
}

const MICRO_RULES = [
  rule("DiagnosticReport", "result", /^\/result\/\d+\/reference$/, "Observation"),
  rule("DiagnosticReport", "specimen", /^\/specimen\/\d+\/reference$/, "Specimen"),
  rule("Observation", "hasMember", /^\/hasMember\/\d+\/reference$/, "Observation"),
  rule("Observation", "specimen", /^\/specimen\/reference$/, "Specimen")
] as const;

const CLINICAL_RULES = [
  ...MICRO_RULES,
  rule("Condition", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule("Condition", "subject", /^\/subject\/reference$/, "Patient"),
  rule("DiagnosticReport", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule("DiagnosticReport", "subject", /^\/subject\/reference$/, "Patient"),
  rule("Encounter", "diagnosis.condition", /^\/diagnosis\/\d+\/condition\/reference$/, "Condition"),
  rule("Encounter", "partOf", /^\/partOf\/reference$/, "Encounter"),
  rule("Encounter", "reasonReference", /^\/reasonReference\/\d+\/reference$/, "Condition"),
  rule("Encounter", "subject", /^\/subject\/reference$/, "Patient"),
  rule("MedicationRequest", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule("MedicationRequest", "medicationReference", /^\/medicationReference\/reference$/, "Medication"),
  rule("MedicationRequest", "reasonReference", /^\/reasonReference\/\d+\/reference$/, "Condition"),
  rule("MedicationRequest", "subject", /^\/subject\/reference$/, "Patient"),
  rule("Observation", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule("Observation", "subject", /^\/subject\/reference$/, "Patient"),
  rule("Procedure", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule(
    "Procedure",
    "report",
    /^\/report\/\d+\/reference$/,
    "DiagnosticReport",
    "DocumentReference"
  ),
  rule("Procedure", "subject", /^\/subject\/reference$/, "Patient"),
  rule("ServiceRequest", "encounter", /^\/encounter\/reference$/, "Encounter"),
  rule("ServiceRequest", "specimen", /^\/specimen\/\d+\/reference$/, "Specimen"),
  rule("ServiceRequest", "subject", /^\/subject\/reference$/, "Patient"),
  rule("Specimen", "parent", /^\/parent\/\d+\/reference$/, "Specimen"),
  rule("Specimen", "request", /^\/request\/\d+\/reference$/, "ServiceRequest"),
  rule("Specimen", "subject", /^\/subject\/reference$/, "Patient")
].sort((left, right) =>
  `${left.sourceType}.${left.pathFamily}`.localeCompare(`${right.sourceType}.${right.pathFamily}`)
);

export const REFERENCE_PROFILES: Readonly<Record<ReferenceProfileName, ReferenceProfile>> = {
  "micro-evidence-v1": {
    name: "micro-evidence-v1",
    evidenceStatus: "measured-exploratory",
    rules: MICRO_RULES
  },
  "clinical-reference-v1": {
    name: "clinical-reference-v1",
    evidenceStatus: "experimental-unvalidated",
    rules: CLINICAL_RULES
  }
};

export function referenceProfile(name: ReferenceProfileName): ReferenceProfile {
  return REFERENCE_PROFILES[name];
}

export function isAllowedReferenceEdge(
  profileName: ReferenceProfileName,
  edge: {
    readonly sourceResourceType: string;
    readonly jsonPath: string;
    readonly targetResourceType: string;
  }
): boolean {
  return referenceProfile(profileName).rules.some(
    (candidate) =>
      candidate.sourceType === edge.sourceResourceType &&
      candidate.pointerPattern.test(edge.jsonPath) &&
      candidate.targetTypes.includes(edge.targetResourceType)
  );
}
