import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { addStaffMember, createOrganizationWithOwner } from '../helpers/clients';
import * as supabaseServerModule from '@/lib/supabase/server';
import { getStaffContext } from '@/features/auth/context';

vi.mock('@/lib/supabase/server');

describe('members query underlying getStaffContext', () => {
  it("without a user_id filter, a non-owner can still see the owner's row via RLS (the bug's root cause)", async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Context Bug', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    // This is the actual claim: RLS's `members_select_own_orgs` policy narrows to "any row in an
    // org this user belongs to," not "this user's own row." The staff member's client can see
    // BOTH members of the org — proving `.limit(1)` with no `user_id` filter has no principled way
    // to pick "the caller's own row" out of that set, which is exactly the bug's root cause.
    const { data, error } = await staff.client.from('members').select('role');

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data?.map((r) => r.role).sort()).toEqual(['owner', 'staff']);
  });

  it("with a user_id filter, each member reliably gets their own role, matching getStaffContext's fix", async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Context Fixed', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    const { data: ownerRow } = await owner.client
      .from('members')
      .select('role')
      .eq('user_id', owner.userId)
      .maybeSingle();
    const { data: staffRow } = await staff.client
      .from('members')
      .select('role')
      .eq('user_id', staff.userId)
      .maybeSingle();

    expect(ownerRow?.role).toBe('owner');
    expect(staffRow?.role).toBe('staff');
  });
});

describe('getStaffContext error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when the underlying members query returns an error, rather than swallowing it', async () => {
    const userId = randomUUID();

    // Minimal chainable stub covering just the .from('members').select().eq().order().limit()
    // .maybeSingle() call chain getStaffContext() makes, plus .auth.getUser().
    const queryBuilder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'simulated failure' } }),
    };

    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId, email: 'owner@example.test' } } }),
      },
      from: vi.fn().mockReturnValue(queryBuilder),
    };

    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(mockClient as never);

    await expect(getStaffContext()).rejects.toThrow('getStaffContext: simulated failure');
  });
});
