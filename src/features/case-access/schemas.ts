import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

export const permissionSchema = z.enum(['upload', 'view', 'none']);

export const issueInvitationSchema = z.object({
  organizationId: z.string().uuid(),
  caseId: z.string().uuid(),
  clientId: z.string().uuid(),
  permission: permissionSchema.default('upload'),
});

export type IssueInvitationInput = z.infer<typeof issueInvitationSchema>;

/**
 * The invitation token, and nothing else.
 *
 * Notably absent is an email field. The invited address is read from the grant row, never
 * accepted from the caller — that is what stops this endpoint from becoming an account
 * enumeration or mail-bombing surface (design.md D5).
 */
export const invitationTokenSchema = z.object({
  token: z.string().min(1).max(512),
});

export const verifyOtpSchema = z.object({
  token: z.string().min(1).max(512),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The code is six digits'),
});

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const revokeGrantSchema = z.object({
  grantId: z.string().uuid(),
});

export const changePermissionSchema = z.object({
  grantId: z.string().uuid(),
  permission: permissionSchema,
});
