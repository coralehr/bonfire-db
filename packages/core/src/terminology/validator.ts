/**
 * The terminology validator seam — I/O byte-compatible with FHIR
 * `$validate-code`. The default `BundledPackValidator` (bundled-pack-validator.ts)
 * checks local SQL set-membership; a `RemoteTxValidator` can be swapped in with
 * no schema change to delegate to a real terminology server. The stub here is
 * interface-only: it holds NO HTTP client, so validate-on-write can NEVER make a
 * blocking network call (the remote path is deferred, and fails loud until wired).
 */

/** A `$validate-code` request: the coding to check. */
export interface ValidateCodeRequest {
  readonly system: string;
  readonly code: string;
  readonly display?: string;
}

/** A `$validate-code` result: membership plus the pack version it was checked against. */
export interface ValidateCodeResult {
  readonly result: boolean;
  readonly version?: string;
  readonly message?: string;
}

/** The swappable terminology validator interface. */
export interface TerminologyValidator {
  validateCode(request: ValidateCodeRequest): Promise<ValidateCodeResult>;
}

/** Thrown by the deferred remote-terminology seam until a real server is wired. */
export class TerminologyNotImplementedError extends Error {
  public constructor() {
    super("RemoteTxValidator is a deferred seam — no terminology server is wired");
    this.name = "TerminologyNotImplementedError";
  }
}

/**
 * The remote seam: rejects with TerminologyNotImplementedError. It never opens a
 * connection, so wiring it in would fail loud rather than silently blocking a
 * write on the network — validate-on-write stays offline by construction.
 */
export function createRemoteTxValidator(): TerminologyValidator {
  return {
    validateCode(): Promise<ValidateCodeResult> {
      return Promise.reject(new TerminologyNotImplementedError());
    }
  };
}
