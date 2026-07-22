import { z } from 'zod';

/**
 * Mirrors the bucket configuration in supabase/migrations/*_storage_buckets.sql.
 *
 * Two enforcement points on purpose: this one rejects before a Document row or an object exists,
 * and the bucket rejects anything that reaches storage by another path. Client-side validation
 * is never trusted, and neither is a single server-side check.
 */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const;

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const uploadDocumentSchema = z.object({
  organizationId: z.string().uuid(),
  caseId: z.string().uuid(),
  requirementId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_DOCUMENT_BYTES, `Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MiB or smaller`),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export const reviewDecisionSchema = z.object({
  documentId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(2000).optional(),
});

export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
