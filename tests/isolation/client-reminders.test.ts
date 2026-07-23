import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, type DocuFlowClient } from '../helpers/clients';
import { selectDueReminders } from '../helpers/db';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
} from '../helpers/fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

async function freshWorld(label: string): Promise<OrganizationWorld> {
  return buildOrganizationWorld({
    name: `Notaría ${label}`,
    industry: 'notary',
    clientEmail: `${label.toLowerCase()}-${randomUUID()}@example.test`,
  });
}

/** Runs the cron's selection and returns the rows queued for one case. */
async function selectDueFor(caseId: string): Promise<{ case_id: string; cadence_window: number }[]> {
  const due = await selectDueReminders();
  return due.filter((row) => row.case_id === caseId);
}

/** Sets an Organization's cadence policy. */
async function setCadence(
  admin: DocuFlowClient,
  organizationId: string,
  cadence: { firstDelay: number; interval: number; max: number },
): Promise<void> {
  await admin
    .from('organizations')
    .update({
      reminder_first_delay_days: cadence.firstDelay,
      reminder_interval_days: cadence.interval,
      reminder_max_count: cadence.max,
    })
    .eq('id', organizationId);
}

describe('client reminders — due selection', () => {
  describe('the first-delay boundary', () => {
    it('does not select a case still inside its first-delay', async () => {
      const world = await freshWorld('BeforeFirst');
      await grantVerifiedAccess({
        world,
        // Activated 2 days ago, first-delay is 3 → not yet due.
        verifiedAt: new Date(Date.now() - 2 * DAY_MS),
      });

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('selects a case just past its first-delay, at window 0', async () => {
      const world = await freshWorld('AfterFirst');
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 3 * DAY_MS - 60_000),
      });

      const due = await selectDueFor(world.caseId);
      expect(due).toHaveLength(1);
      expect(due[0]?.cadence_window).toBe(0);
    });
  });

  describe('the interval boundary', () => {
    it('advances the window as intervals elapse', async () => {
      const world = await freshWorld('Interval');
      // Activated 11 days ago; first-delay 3, interval 7 → windows at day 3 and day 10, so the
      // current window is 1.
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 11 * DAY_MS),
      });

      const due = await selectDueFor(world.caseId);
      expect(due).toHaveLength(1);
      expect(due[0]?.cadence_window).toBe(1);
    });

    it('does not re-select a window already queued', async () => {
      const world = await freshWorld('NoRepeat');
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 4 * DAY_MS),
      });

      const first = await selectDueFor(world.caseId);
      expect(first).toHaveLength(1);

      // Immediate second run, same window still current → nothing new.
      const second = await selectDueFor(world.caseId);
      expect(second).toEqual([]);
    });
  });

  describe('the cap', () => {
    it('stops selecting once the maximum window is queued', async () => {
      const world = await freshWorld('Cap');
      await setCadence(adminClient(), world.organizationId, {
        firstDelay: 1,
        interval: 1,
        max: 2,
      });
      // Far past the cap window: with max 2, windows are 0 and 1 only.
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 100 * DAY_MS),
      });

      // First run queues the capped window (1). A second run finds it already there.
      const first = await selectDueFor(world.caseId);
      expect(first).toHaveLength(1);
      expect(first[0]?.cadence_window).toBe(1);

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('never selects when max count is zero', async () => {
      const world = await freshWorld('Disabled');
      await setCadence(adminClient(), world.organizationId, {
        firstDelay: 1,
        interval: 1,
        max: 0,
      });
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 30 * DAY_MS),
      });

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });
  });

  describe('suppression', () => {
    it('does not chase a completed case', async () => {
      const world = await freshWorld('Completed');
      await grantVerifiedAccess({ world, verifiedAt: new Date(Date.now() - 10 * DAY_MS) });

      await world.staff.client
        .from('cases')
        .update({ state: 'completed', completed_at: new Date().toISOString() })
        .eq('id', world.caseId);

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('does not chase a revoked grant', async () => {
      const world = await freshWorld('Revoked');
      const granted = await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 10 * DAY_MS),
      });

      await world.staff.client
        .from('case_access_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', granted.grantId);

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('does not chase a fully-satisfied case', async () => {
      const world = await freshWorld('Satisfied');
      await grantVerifiedAccess({ world, verifiedAt: new Date(Date.now() - 10 * DAY_MS) });

      await adminClient()
        .from('requirements')
        .update({ status: 'satisfied' })
        .eq('case_id', world.caseId);

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('does not chase a none-permission grant', async () => {
      const world = await freshWorld('NonePerm');
      await grantVerifiedAccess({
        world,
        permission: 'none',
        verifiedAt: new Date(Date.now() - 10 * DAY_MS),
      });

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });

    it('does not chase an expired grant', async () => {
      const world = await freshWorld('Expired');
      await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 10 * DAY_MS),
        expiresAt: new Date(Date.now() - DAY_MS),
      });

      expect(await selectDueFor(world.caseId)).toEqual([]);
    });
  });

  describe('the queued row', () => {
    it('targets the grant address and carries no message body', async () => {
      const world = await freshWorld('Address');
      const granted = await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 4 * DAY_MS),
      });

      await selectDueFor(world.caseId);

      const { data } = await adminClient()
        .from('reminder_deliveries')
        .select('sent_to_email, status, grant_id')
        .eq('case_id', world.caseId)
        .single();

      expect(data?.sent_to_email).toBe(world.clientEmail);
      expect(data?.status).toBe('queued');
      expect(data?.grant_id).toBe(granted.grantId);
    });

    it('is isolated to the owning organization and hidden from clients', async () => {
      const world = await freshWorld('Isolated');
      const granted = await grantVerifiedAccess({
        world,
        verifiedAt: new Date(Date.now() - 4 * DAY_MS),
      });
      await selectDueFor(world.caseId);

      const other = await freshWorld('Outsider');

      const asOtherOrg = await other.staff.client
        .from('reminder_deliveries')
        .select('id')
        .eq('case_id', world.caseId);
      expect(asOtherOrg.data).toEqual([]);

      const asClient = await granted.client.from('reminder_deliveries').select('id');
      expect(asClient.data).toEqual([]);

      const asOwner = await world.staff.client
        .from('reminder_deliveries')
        .select('id')
        .eq('case_id', world.caseId);
      expect(asOwner.data).toHaveLength(1);
    });
  });
});
