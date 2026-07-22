import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createTestUser } from '../helpers/clients';
import { buildOrganizationWorld, type OrganizationWorld } from '../helpers/fixtures';
import { randomUUID } from 'node:crypto';

describe('case workflow', () => {
  let world: OrganizationWorld;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Clone',
      industry: 'notary',
      clientEmail: `clone-${randomUUID()}@example.test`,
    });
  });

  describe('cloning a blueprint', () => {
    it('copies every requirement definition into the case', async () => {
      expect(world.requirementIds).toHaveLength(3);

      const { data } = await world.staff.client
        .from('requirements')
        .select('label, position, type')
        .eq('case_id', world.caseId)
        .order('position');

      expect(data?.map((r) => r.label)).toEqual([
        'Identity document',
        'Proof of address',
        'Signed mandate',
      ]);
      expect(data?.map((r) => r.position)).toEqual([0, 1, 2]);
      expect(data?.every((r) => r.type === 'document')).toBe(true);
    });

    it('leaves the case untouched when the blueprint is later edited', async () => {
      const before = await world.staff.client
        .from('requirements')
        .select('label, position')
        .eq('case_id', world.caseId)
        .order('position');

      await world.owner.client
        .from('blueprints')
        .update({
          requirement_definitions: [{ type: 'document', label: 'Completely different' }],
        })
        .eq('id', world.blueprintId);

      const after = await world.staff.client
        .from('requirements')
        .select('label, position')
        .eq('case_id', world.caseId)
        .order('position');

      expect(after.data).toEqual(before.data);
    });

    it('leaves the case intact when the blueprint is deleted', async () => {
      const scratch = await buildOrganizationWorld({
        name: 'Notaría Delete',
        industry: 'notary',
        clientEmail: `del-${randomUUID()}@example.test`,
      });

      await scratch.owner.client.from('blueprints').delete().eq('id', scratch.blueprintId);

      const { data: requirements } = await scratch.staff.client
        .from('requirements')
        .select('id')
        .eq('case_id', scratch.caseId);

      const { data: theCase } = await scratch.staff.client
        .from('cases')
        .select('id, origin_blueprint_id')
        .eq('id', scratch.caseId)
        .single();

      expect(requirements).toHaveLength(3);
      expect(theCase?.id).toBe(scratch.caseId);
      expect(theCase?.origin_blueprint_id).toBeNull();
    });

    it('creates a blank case when no blueprint is given', async () => {
      const { data: caseId, error } = await world.staff.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Blank case',
      });

      expect(error).toBeNull();

      const { data: requirements } = await world.staff.client
        .from('requirements')
        .select('id')
        .eq('case_id', caseId as string);

      expect(requirements).toEqual([]);
    });
  });

  describe('per-case requirement mutation', () => {
    it('adds a requirement to one case without touching its sibling', async () => {
      const { data: siblingId } = await world.staff.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Sibling case',
        from_blueprint_id: world.blueprintId,
      });

      const { error } = await world.staff.client.from('requirements').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        type: 'document',
        label: 'Extra requirement',
        position: 99,
      });
      expect(error).toBeNull();

      const { data: sibling } = await world.staff.client
        .from('requirements')
        .select('label')
        .eq('case_id', siblingId as string);

      expect(sibling?.map((r) => r.label)).not.toContain('Extra requirement');
    });

    it('persists a reorder', async () => {
      const first = world.requirementIds[0];
      const second = world.requirementIds[1];
      if (!first || !second) throw new Error('fixture requirements missing');

      await world.staff.client.from('requirements').update({ position: 1 }).eq('id', first);
      await world.staff.client.from('requirements').update({ position: 0 }).eq('id', second);

      const { data } = await world.staff.client
        .from('requirements')
        .select('id')
        .in('id', [first, second])
        .order('position');

      expect(data?.map((r) => r.id)).toEqual([second, first]);
    });

    it('hides a soft-deleted requirement from the active view but keeps the row', async () => {
      const target = world.requirementIds[2];
      if (!target) throw new Error('fixture requirement missing');

      await world.staff.client
        .from('requirements')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', target);

      const active = await world.staff.client
        .from('active_requirements')
        .select('id')
        .eq('id', target);

      const raw = await world.staff.client.from('requirements').select('id').eq('id', target);

      expect(active.data).toEqual([]);
      expect(raw.data).toHaveLength(1);
    });
  });

  describe('requirement types', () => {
    it('rejects a type outside the constrained set', async () => {
      const { error } = await adminClient()
        .from('requirements')
        .insert({
          organization_id: world.organizationId,
          case_id: world.caseId,
          type: 'hologram' as 'document',
          label: 'Unknown type',
          position: 50,
        });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/check constraint/i);
    });

    it('refuses a defined but unimplemented type with an explicit error', async () => {
      const { error } = await world.staff.client.from('requirements').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        type: 'signature',
        label: 'Not yet implemented',
        position: 51,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/unsupported requirement type: signature/i);
    });
  });

  describe('tenant integrity', () => {
    it('cannot attach a case to a client from another organization', async () => {
      const other = await buildOrganizationWorld({
        name: 'Otra Notaría',
        industry: 'notary',
        clientEmail: `otra-${randomUUID()}@example.test`,
      });

      const { error } = await adminClient().from('cases').insert({
        organization_id: world.organizationId,
        client_id: other.clientId,
        title: 'Cross-tenant case',
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key/i);
    });

    it('refuses case creation by a non-member', async () => {
      const outsider = await createTestUser('outsider');

      const { error } = await outsider.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Intruder case',
      });

      expect(error).not.toBeNull();
    });
  });
});
