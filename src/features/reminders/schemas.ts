import { z } from 'zod';

/**
 * The reminder email payload.
 *
 * Assembled server-side from the queued delivery and the Case it belongs to. The recipient is
 * never taken from a caller — it comes from the delivery row, which copied it from the grant at
 * queue time.
 */
export const reminderEmailSchema = z.object({
  to: z.string().email(),
  organizationName: z.string().min(1),
  caseTitle: z.string().min(1),
  outstandingCount: z.number().int().positive(),
  actionUrl: z.string().url(),
});

export type ReminderEmail = z.infer<typeof reminderEmailSchema>;

/** The subset of Resend's send response we depend on. */
export const resendResponseSchema = z.object({
  id: z.string().min(1),
});
