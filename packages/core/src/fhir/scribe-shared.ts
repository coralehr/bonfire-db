/**
 * Shared FHIR-aligned sub-schemas for the scribe write inputs. Factored here so
 * the nine resource schemas compose them instead of re-declaring CodeableConcept
 * / Identifier / Reference shapes (jscpd would flag the duplication) and so the
 * typed→FHIR round-trip is structural: a scribe input is a validated FHIR
 * resource minus its server-stamped `meta`, nothing more.
 */
import { z } from "zod";

const nonEmpty = z.string().min(1);

/** A FHIR Coding: system + code (+ optional display). */
export const codingSchema = z.strictObject({
  system: nonEmpty,
  code: nonEmpty,
  display: nonEmpty.optional()
});

/** A FHIR CodeableConcept with at least one coding. */
export const codeableConceptSchema = z.strictObject({
  coding: z.array(codingSchema).min(1),
  text: nonEmpty.optional()
});

/** A FHIR Identifier (system + value). */
export const identifierSchema = z.strictObject({
  system: nonEmpty,
  value: nonEmpty
});

/** A FHIR HumanName; `family` is required so US Core name minimums hold. */
export const humanNameSchema = z.strictObject({
  family: nonEmpty,
  given: z.array(nonEmpty).min(1).optional()
});

/** A FHIR Reference by relative literal (e.g. "Patient/<uuid>"). */
export const referenceSchema = z.strictObject({
  reference: nonEmpty
});

/** A FHIR Quantity (UCUM value/unit). */
export const quantitySchema = z.strictObject({
  value: z.number(),
  unit: nonEmpty.optional(),
  system: nonEmpty.optional(),
  code: nonEmpty.optional()
});

/** A FHIR Attachment used by DocumentReference.content. */
const attachmentSchema = z.strictObject({
  contentType: nonEmpty,
  url: nonEmpty
});

/** A DocumentReference.content entry (attachment + optional format Coding). */
export const documentContentSchema = z.strictObject({
  attachment: attachmentSchema,
  format: codingSchema.optional()
});

/**
 * A required-strength status CodeableConcept: its coding is pinned to one
 * system and its code to a closed enum, so an off-value fails Zod at the
 * boundary (fail-closed reject) while the CodeableConcept shape round-trips.
 */
export function statusConceptSchema<const C extends readonly [string, ...string[]]>(
  system: string,
  codes: C
) {
  return z.strictObject({
    coding: z
      .array(
        z.strictObject({
          system: z.literal(system),
          code: z.enum(codes),
          display: nonEmpty.optional()
        })
      )
      .min(1),
    text: nonEmpty.optional()
  });
}
