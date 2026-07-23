import { Client } from 'pg';

/**
 * A direct Postgres connection, for the few things PostgREST cannot reach: catalog introspection,
 * and functions in the unexposed `app` schema.
 *
 * `app.queue_reminders()` is invoked here exactly as pg_cron invokes it in production — as SQL,
 * not over the API — so the test path matches the real one.
 */
export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env['SUPABASE_DB_URL'];
  if (!connectionString) throw new Error('Missing SUPABASE_DB_URL. Run: npm run db:env');

  const db = new Client({ connectionString });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export interface DueReminder {
  readonly delivery_id: string;
  readonly participant_id: string;
  readonly organization_id: string;
  readonly case_id: string;
  readonly grant_id: string;
  readonly channel: string;
  readonly destination: string;
  readonly cadence_window: number;
}

/** Queues due reminders the way the cron does, and returns what was queued. */
export async function queueDueReminders(): Promise<DueReminder[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<DueReminder>('select * from app.queue_reminders()');
    return rows;
  });
}

/** Pure selection, no side effects — mirrors `app.eligible_reminders()`. */
export async function eligibleReminders(): Promise<Omit<DueReminder, 'delivery_id'>[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<Omit<DueReminder, 'delivery_id'>>(
      'select * from app.eligible_reminders()',
    );
    return rows;
  });
}
