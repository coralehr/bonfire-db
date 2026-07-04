/**
 * Minimal ambient typing for the fhirpath.js internal types module. The
 * published package ships no declaration for this subpath; only the FHIR
 * primitive wrapper constructors used to type ViewDefinition constants are
 * declared here, each fully typed (no `any`). Constructor signatures are
 * (ctx, value) — the evaluation context slot accepts a plain empty object.
 */
declare module "fhirpath/src/types.js" {
  const internals: {
    FP_Date: new (ctx: object, value: string) => object;
    FP_DateTime: new (ctx: object, value: string) => object;
    FP_Instant: new (ctx: object, value: string) => object;
    FP_Time: new (ctx: object, value: string) => object;
  };
  export default internals;
}
