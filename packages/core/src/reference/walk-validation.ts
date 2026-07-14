import { z } from "zod";
import { REFERENCE_PROFILE_NAMES } from "./semantic-catalog.js";
import { REFERENCE_TRAVERSAL_LIMITS } from "./walk-types.js";

export const referenceResourceKeySchema = z.object({
  resourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  resourceId: z.string().min(1).max(REFERENCE_TRAVERSAL_LIMITS.resourceIdLength)
});

export const referenceTraversalBoundsSchema = z.object({
  maxDepth: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.depth),
  maxTargets: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.targets),
  maxEdges: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.edges),
  maxCitations: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.citations)
});

export const referenceTraversalOptionsSchema = referenceTraversalBoundsSchema.extend({
  profile: z.enum(REFERENCE_PROFILE_NAMES),
  allowedResourceTypes: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/))
    .min(1)
    .max(REFERENCE_TRAVERSAL_LIMITS.allowedResourceTypes)
});
