import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import type { AdminClient } from '@/lib/supabase/admin';
import * as inviteMemberModule from '@/application/invite-member';
import * as authContextModule from '@/features/auth/context';
import * as supabaseServerModule from '@/lib/supabase/server';
import * as supabaseAdminModule from '@/lib/supabase/admin';
import * as nextCacheModule from 'next/cache';
import { inviteMemberAction } from '@/app/members/actions';
import { UseCaseError } from '@/application/errors';

vi.mock('@/application/invite-member');
vi.mock('@/features/auth/context');
vi.mock('@/lib/supabase/server');
vi.mock('@/lib/supabase/admin');
vi.mock('next/cache');

describe('inviteMemberAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unauthenticated when getStaffContext returns null', async () => {
    const email = `test-${randomUUID()}@example.test`;

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(null);

    const result = await inviteMemberAction(email);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthenticated');
    }
  });

  it('returns forbidden when caller is not an owner', async () => {
    const organizationId = randomUUID();
    const email = `forbidden-${randomUUID()}@example.test`;

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue({
      organizationId,
      role: 'staff',
      userId: randomUUID(),
      email: 'staff@example.test',
      organizationName: 'Test Org',
      organizationIndustry: 'notary',
    });

    const result = await inviteMemberAction(email);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('forbidden');
    }
  });

  it('delegates to inviteMember when caller is authenticated owner', async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const email = `success-${randomUUID()}@example.test`;
    const mockClient = {} as SupabaseClient<Database>;
    const mockAdminClient = {} as AdminClient;

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue({
      organizationId,
      role: 'owner',
      userId,
      email: 'owner@example.test',
      organizationName: 'Test Org',
      organizationIndustry: 'notary',
    });

    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(mockClient);
    vi.spyOn(supabaseAdminModule, 'createAdminClient').mockReturnValue(mockAdminClient);
    vi.spyOn(inviteMemberModule, 'inviteMember').mockResolvedValue(undefined);
    vi.spyOn(nextCacheModule, 'revalidatePath').mockImplementation(() => {});

    const result = await inviteMemberAction(email);

    expect(result.ok).toBe(true);
    expect(inviteMemberModule.inviteMember).toHaveBeenCalledWith(mockClient, mockAdminClient, {
      organizationId,
      email,
    });
    expect(nextCacheModule.revalidatePath).toHaveBeenCalledWith('/members');
  });

  it('converts UseCaseError to ActionResult', async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const email = `conflict-${randomUUID()}@example.test`;
    const mockClient = {} as SupabaseClient<Database>;
    const mockAdminClient = {} as AdminClient;

    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue({
      organizationId,
      role: 'owner',
      userId,
      email: 'owner@example.test',
      organizationName: 'Test Org',
      organizationIndustry: 'notary',
    });

    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(mockClient);
    vi.spyOn(supabaseAdminModule, 'createAdminClient').mockReturnValue(mockAdminClient);

    const useCaseError = new UseCaseError('conflict', 'Already a member');

    vi.spyOn(inviteMemberModule, 'inviteMember').mockRejectedValue(useCaseError);

    const result = await inviteMemberAction(email);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('conflict');
      expect(result.message).toBe('Already a member');
    }
  });
});
