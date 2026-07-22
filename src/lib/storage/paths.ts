/**
 * The single place object paths are built (design.md D10).
 *
 * Storage policies authorize by parsing this path — folder 1 is the tenant, folder 3 is the
 * Case. Constructing a path anywhere else risks a shape the policies read differently, which is
 * the one way storage and table authorization could disagree.
 */

export const CASE_DOCUMENTS_BUCKET = 'case-documents';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentObjectLocation {
  readonly organizationId: string;
  readonly caseId: string;
  readonly requirementId: string;
  readonly documentId: string;
}

/**
 * `{organizationId}/cases/{caseId}/requirements/{requirementId}/{documentId}`
 *
 * The original file name is deliberately absent: it is untrusted client input, it is already
 * recorded on the `documents` row, and keeping it out of the path removes path traversal and
 * encoding as concerns entirely.
 */
export function documentObjectPath(location: DocumentObjectLocation): string {
  for (const [field, value] of Object.entries(location)) {
    if (!UUID_PATTERN.test(value)) {
      throw new Error(`documentObjectPath: ${field} is not a UUID`);
    }
  }

  const { organizationId, caseId, requirementId, documentId } = location;
  return `${organizationId}/cases/${caseId}/requirements/${requirementId}/${documentId}`;
}

/**
 * Reads a path back into its parts, or null if it does not match the expected shape.
 *
 * Returns null rather than throwing so callers handling stored paths of unknown provenance fail
 * closed, matching how `app.safe_uuid` treats a malformed path in the storage policies.
 */
export function parseDocumentObjectPath(path: string): DocumentObjectLocation | null {
  const segments = path.split('/');

  if (segments.length !== 6) return null;

  const [organizationId, casesLiteral, caseId, requirementsLiteral, requirementId, documentId] =
    segments;

  if (casesLiteral !== 'cases' || requirementsLiteral !== 'requirements') return null;

  const ids = { organizationId, caseId, requirementId, documentId };
  for (const value of Object.values(ids)) {
    if (value === undefined || !UUID_PATTERN.test(value)) return null;
  }

  return ids as DocumentObjectLocation;
}
