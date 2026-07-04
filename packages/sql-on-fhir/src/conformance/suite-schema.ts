/**
 * Zod boundary schemas for the vendored HL7 SQL-on-FHIR conformance suite
 * (fixtures/sql-on-fhir): the pin manifest and the per-file test shape.
 */
import { jsonValueSchema } from "@bonfire/core";
import { z } from "zod";

const SHA256_HEX_LENGTH = 64;

export const manifestSchema = z.object({
  source: z.object({
    repo: z.string().min(1),
    commit: z.string().min(1),
    license: z.string().min(1),
    note: z.string().optional()
  }),
  fhirpathVersion: z.string().min(1),
  totalFiles: z.number().int().positive(),
  totalCases: z.number().int().positive(),
  shareableCases: z.number().int().positive(),
  declaredUnsupported: z.array(
    z.object({
      file: z.string().min(1),
      title: z.string().min(1),
      reason: z.string().min(1)
    })
  ),
  files: z.record(
    z.string(),
    z.object({ sha256: z.string().length(SHA256_HEX_LENGTH), cases: z.number().int() })
  )
});

export type SuiteManifest = z.infer<typeof manifestSchema>;

const suiteResourceSchema = z.record(z.string(), jsonValueSchema);

const suiteCaseSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    view: jsonValueSchema,
    expect: z.array(z.record(z.string(), jsonValueSchema)).optional(),
    expectError: z.boolean().optional(),
    expectColumns: z.array(z.string()).optional()
  })
  // Fail-closed on unknown expectation kinds: Zod strips keys it does not
  // model (e.g. upstream `expectCount`), and a case with NO modeled
  // expectation would run zero assertions yet count as passed. A future
  // re-vendor introducing such a case must break the load, not fake a pass.
  .refine(
    (c) => c.expect !== undefined || c.expectError === true || c.expectColumns !== undefined,
    { message: "case carries no supported expectation (expect/expectError/expectColumns)" }
  );

export type SuiteCase = z.infer<typeof suiteCaseSchema>;

export const suiteFileSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  fhirVersion: z.union([z.string(), z.array(z.string())]).optional(),
  resources: z.array(suiteResourceSchema),
  tests: z.array(suiteCaseSchema).min(1)
});

export type SuiteFile = z.infer<typeof suiteFileSchema>;
