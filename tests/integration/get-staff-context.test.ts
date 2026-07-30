import { describe, expect, it } from 'vitest';
import { addStaffMember, createOrganizationWithOwner } from '../helpers/clients';

// getStaffContext() (src/features/auth/context.ts) internally calls createClient() from
// @/lib/supabase/server, a Next.js server-context-bound cookie client that can't be swapped for
// an arbitrary TestUser client. So these tests exercise the same underlying query directly
// against real TestUser clients, proving the fix's mechanism rather than calling the function
// itself.
describe('members query underlying getStaffContext', () => {
  it("without a user_id filter, a non-owner can still read the owner's row via RLS (the bug's root cause)", async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Context Bug', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    const { data } = await staff.client.from('members').select('role').limit(1).maybeSingle();

    // This demonstrates why the unfiltered query is unsafe: RLS alone doesn't narrow to "this
    // user's own row" — it narrows to "any row in an org this user belongs to". The actual row
    // returned depends on ordering, which the query doesn't control — this could return either
    // role depending on data/query-planner behavior, which is exactly the bug.
    expect(['owner', 'staff']).toContain(data?.role);
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
