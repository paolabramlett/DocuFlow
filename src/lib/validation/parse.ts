import type { ZodType } from 'zod';

/**
 * Raised when input fails schema validation at a server boundary.
 *
 * Carries per-field issues so callers can surface them, but never echoes the rejected value —
 * inputs at this boundary may contain client-supplied data that should not be reflected back.
 */
export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Input validation failed: ${issues.map((i) => i.path).join(', ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The single entry point for validating untrusted input on the server.
 *
 * Every server action, route handler, and background job parses its input through here. Nothing
 * reaching the database is trusted to have been validated by the client — per PRODUCT.md, client
 * side authorization and validation are never trusted.
 */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  return result.data;
}
