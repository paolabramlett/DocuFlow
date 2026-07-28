/**
 * Application-layer failures.
 *
 * Use cases fail with a typed reason rather than a bare Error, so Server Actions can return a
 * discriminated result and the UI can render a dedicated state for each — never a generic
 * "something went wrong". The `message` is user-facing (Spanish, product voice); `reason` is what
 * code branches on.
 */

export type FailureReason =
  | "unauthenticated"
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "delivery_failed"
  | "unexpected";

/**
 * The minimal identity a use case needs to authorize itself, independent of whatever the caller
 * (a Server Action, a script, a test) already believes about that identity's role. A use case
 * that receives only this and re-derives authorization from the database — rather than trusting
 * a boolean the caller hands it — cannot be bypassed by a caller-side bug.
 */
export interface ActorContext {
  readonly authUserId: string;
}

export class UseCaseError extends Error {
  readonly reason: FailureReason;
  /** Field-level issues, when the failure came from input validation. */
  readonly issues?: readonly { path: string; message: string }[];

  constructor(
    reason: FailureReason,
    message: string,
    issues?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = "UseCaseError";
    this.reason = reason;
    this.issues = issues;
  }
}

/** The result shape every Server Action returns. Never throws across the client boundary. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FailureReason; message: string; issues?: readonly { path: string; message: string }[] };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(error: unknown): ActionResult<never> {
  if (error instanceof UseCaseError) {
    return { ok: false, reason: error.reason, message: error.message, issues: error.issues };
  }
  // Unexpected failures keep their detail server-side; the user gets a stable, honest message.
  console.error("Unexpected use-case failure:", error);
  return {
    ok: false,
    reason: "unexpected",
    message: "Algo falló de nuestro lado. Vuelve a intentarlo en un momento.",
  };
}
