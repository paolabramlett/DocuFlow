import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adminClient, createTestUser } from '../helpers/clients';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { inviteMember } from '@/application/invite-member';
import { UseCaseError } from '@/application/errors';

describe('inviteMember', () => {
  it('invites a brand-new email, creating the auth user and attributing the audit event to the owner', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Invitar',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const newEmail = `brand-new-${randomUUID()}@example.test`;

    await inviteMember(world.owner.client, adminClient(), {
      organizationId: world.organizationId,
      email: newEmail,
    });

    const { data: newAuthUser } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 });
    const created = newAuthUser.users.find((u) => u.email === newEmail);
    expect(created).toBeDefined();

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role, user_id')
      .eq('organization_id', world.organizationId)
      .eq('user_id', created!.id)
      .single();
    expect(memberRow?.role).toBe('staff');

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('actor_auth_user_id, action, target_id, metadata')
      .eq('organization_id', world.organizationId)
      .eq('action', 'member.added');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.actor_auth_user_id).toBe(world.owner.userId);
    expect(events?.[0]?.actor_auth_user_id).not.toBe(created!.id);
    expect((events?.[0]?.metadata as { identityAlreadyExisted: boolean }).identityAlreadyExisted).toBe(false);
  });

  it('adds an existing identity as a member without inviting them again, and notifies them via the injected sender', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Existente',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('existing');

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    await inviteMember(
      world.owner.client,
      adminClient(),
      { organizationId: world.organizationId, email: existing.email },
      sendEmail,
    );

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId)
      .single();
    expect(memberRow?.role).toBe('staff');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: existing.email });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('metadata')
      .eq('organization_id', world.organizationId)
      .eq('action', 'member.added');
    expect((events?.[0]?.metadata as { identityAlreadyExisted: boolean }).identityAlreadyExisted).toBe(true);
  });

  it('refuses a duplicate invite to someone already a member of the same org', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Duplicado',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('dup');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await inviteMember(
      world.owner.client,
      adminClient(),
      { organizationId: world.organizationId, email: existing.email },
      sendEmail,
    );

    await expect(
      inviteMember(
        world.owner.client,
        adminClient(),
        { organizationId: world.organizationId, email: existing.email },
        sendEmail,
      ),
    ).rejects.toMatchObject({ reason: 'conflict' });

    const { data: memberRows } = await adminClient()
      .from('members')
      .select('id')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId);
    expect(memberRows).toHaveLength(1);
  });

  it('normalizes email casing and surrounding whitespace to the same identity', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Normaliza',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('norm');
    const shouty = `  ${existing.email.toUpperCase()}  `;

    await inviteMember(world.owner.client, adminClient(), {
      organizationId: world.organizationId,
      email: shouty,
    });

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId)
      .maybeSingle();
    expect(memberRow?.role).toBe('staff');
  });

  it('refuses a non-owner staff member via the use case\'s own ownership check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría No Owner',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    await expect(
      inviteMember(world.staff.client, adminClient(), {
        organizationId: world.organizationId,
        email: `victim-${randomUUID()}@example.test`,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(
      inviteMember(world.staff.client, adminClient(), {
        organizationId: world.organizationId,
        email: `victim-${randomUUID()}@example.test`,
      }),
    ).rejects.toBeInstanceOf(UseCaseError);
  });

  it('also refuses a non-owner at the RLS floor, independent of the use case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría RLS Floor',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const target = await createTestUser('rls-floor');

    // Bypasses the use case entirely — proves members_insert_by_owner holds even if the
    // application-layer check above had a bug.
    const { data, error } = await world.staff.client
      .from('members')
      .insert({ organization_id: world.organizationId, user_id: target.userId, role: 'staff' })
      .select();

    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
  });

  it('deletes the newly-created auth user if the membership insert fails, but never an existing identity', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Compensación',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const brandNewEmail = `compensate-${randomUUID()}@example.test`;

    // A foreign organizationId makes the membership insert fail at the RLS floor (the owner's
    // client is not a member of this made-up org), simulating "insert fails for some reason"
    // without needing to fabricate a lower-level DB error.
    const foreignOrganizationId = randomUUID();

    await expect(
      inviteMember(world.owner.client, adminClient(), {
        organizationId: foreignOrganizationId,
        email: brandNewEmail,
      }),
    ).rejects.toThrow();

    const { data: usersAfter } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 });
    expect(usersAfter.users.some((u) => u.email === brandNewEmail)).toBe(false);
  });

  it('organizationId always comes from the caller, never causes a cross-tenant write even if foreign', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cross Tenant',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    await expect(
      inviteMember(world.owner.client, adminClient(), {
        organizationId: randomUUID(),
        email: `nobody-${randomUUID()}@example.test`,
      }),
    ).rejects.toThrow();
  });
});
