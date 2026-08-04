import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import * as casesModule from '@/features/cases/cases';
import * as authContextModule from '@/features/auth/context';
import * as supabaseServerModule from '@/lib/supabase/server';
import * as nextCacheModule from 'next/cache';
import { reopenCaseAction } from '@/app/cases/actions';

vi.mock('@/features/cases/cases');
vi.mock('@/features/auth/context');
vi.mock('@/lib/supabase/server');
vi.mock('next/cache');

/**
 * Covers the one hop no integration test against the real RPC/use-case layer can: that
 * reopenCaseAction forwards reopenCase's result shape verbatim — including notificationFailureCount
 * — to the caller. This is exactly what the Staff UI's `onReopened` channel (cases-workspace.tsx)
 * consumes; without a component-testing setup in this repo, asserting the Server Action's own
 * output is the closest automated proof that the value the UI reads is the value the use case
 * actually produced, not silently dropped or renamed along the way.
 */
describe('reopenCaseAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unauthenticated when getStaffContext returns null', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(null);

    const result = await reopenCaseAction(randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthenticated');
  });

  it('forwards requiresReinvitation and notificationFailureCount verbatim from reopenCase', async () => {
    const caseId = randomUUID();
    const mockClient = {} as SupabaseClient<Database>;

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue({
      organizationId: randomUUID(),
      role: 'staff',
      userId: randomUUID(),
      email: 'staff@example.test',
      organizationName: 'Test Org',
      organizationIndustry: 'notary',
    });
    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(mockClient);
    vi.spyOn(nextCacheModule, 'revalidatePath').mockImplementation(() => {});
    vi.spyOn(casesModule, 'reopenCase').mockResolvedValue({
      restoredParticipantIds: [randomUUID()],
      requiresReinvitation: false,
      notificationFailureCount: 1,
    });

    const result = await reopenCaseAction(caseId);

    expect(result).toEqual({
      ok: true,
      data: { requiresReinvitation: false, notificationFailureCount: 1 },
    });
    expect(casesModule.reopenCase).toHaveBeenCalledWith(mockClient, caseId);
    expect(nextCacheModule.revalidatePath).toHaveBeenCalledWith('/cases');
  });

  it('converts a UseCaseError from reopenCase into a matching ActionResult failure', async () => {
    const { UseCaseError } = await import('@/application/errors');

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue({
      organizationId: randomUUID(),
      role: 'staff',
      userId: randomUUID(),
      email: 'staff@example.test',
      organizationName: 'Test Org',
      organizationIndustry: 'notary',
    });
    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue({} as SupabaseClient<Database>);
    vi.spyOn(casesModule, 'reopenCase').mockRejectedValue(
      new UseCaseError('conflict', 'Este expediente no está cerrado.'),
    );

    const result = await reopenCaseAction(randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('conflict');
      expect(result.message).toBe('Este expediente no está cerrado.');
    }
  });
});
