import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { closeCase } from '@/features/cases/cases';

describe('case-closure emails: escaping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escapes an HTML-bearing client_closing_note before it reaches the email body', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Email Escape',
      industry: 'notary',
      clientEmail: `email-escape-${randomUUID()}@example.test`,
    });
    await grantVerifiedAccess({ world, permission: 'view' });
    let capturedHtml = '';
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(async (input) => {
      capturedHtml = input.html;
    });

    await closeCase(
      world.staff.client,
      world.caseId,
      'cancelled',
      `<script>alert("hi")</script> & "quotes"`,
    );

    expect(capturedHtml).not.toContain('<script>');
    expect(capturedHtml).toContain('&lt;script&gt;');
    expect(capturedHtml).toContain('&amp;');
    expect(capturedHtml).toContain('&quot;quotes&quot;');
  });
});
