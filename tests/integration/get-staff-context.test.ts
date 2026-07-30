import { describe, expect, it } from 'vitest';
import { addStaffMember, createOrganizationWithOwner } from '../helpers/clients';

// getStaffContext() (src/features/auth/context.ts) internally calls createClient() from
// @/lib/supabase/server, a Next.js server-context-bound cookie client that can't be swapped for
// an arbitrary TestUser client. So these tests exercise the same underlying query directly
// against real TestUser clients, proving the fix's mechanism rather than calling the function
// itself.
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
