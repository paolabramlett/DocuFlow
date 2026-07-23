import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Structural guards.
 *
 * These assert properties of the schema itself rather than the behaviour of any one policy, so a
 * table added later without protection fails here even if nobody remembered to write a test for
 * it. Connects directly to Postgres because catalog views are not reachable over PostgREST.
 */
describe('schema guards', () => {
  let db: Client;

  beforeAll(async () => {
    const connectionString = process.env['SUPABASE_DB_URL'];
    if (!connectionString) throw new Error('Missing SUPABASE_DB_URL. Run: npm run db:env');

    db = new Client({ connectionString });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it('enables row level security on every table in the exposed schema', async () => {
    const { rows } = await db.query<{ tablename: string }>(`
      select c.relname as tablename
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not c.relrowsecurity
    `);

    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it('gives every exposed table at least one policy', async () => {
    const { rows } = await db.query<{ tablename: string }>(`
      select c.relname as tablename
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not exists (
          select 1 from pg_policy p where p.polrelid = c.oid
        )
    `);

    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it('keeps the app schema out of the API-exposed schemas', async () => {
    // `app` holds the SECURITY DEFINER resolvers. Exposure would make the privilege boundary
    // callable directly rather than only from inside a policy.
    const { rows } = await db.query<{ nspname: string }>(`
      select nspname from pg_namespace where nspname = 'app'
    `);

    expect(rows).toHaveLength(1);

    const { rows: exposed } = await db.query<{ has_usage: boolean }>(`
      select has_schema_privilege('anon', 'app', 'usage') as has_usage
    `);

    // anon may resolve names (granted in the foundation migration) but holds execute on nothing.
    expect(exposed[0]?.has_usage).toBe(true);

    const { rows: executable } = await db.query<{ proname: string }>(`
      select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and has_function_privilege('anon', p.oid, 'execute')
    `);

    expect(executable.map((r) => r.proname)).toEqual([]);
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    // An unpinned search_path on a definer function lets a caller shadow a referenced object and
    // execute code as the function owner.
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'public')
        and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
          where cfg like 'search_path=%'
        )
    `);

    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('marks the authorization resolvers STABLE so they evaluate once per statement', async () => {
    const { rows } = await db.query<{ proname: string; provolatile: string }>(`
      select p.proname, p.provolatile
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('member_org_ids', 'granted_case_ids', 'is_org_owner')
    `);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.provolatile).toBe('s');
    }
  });

  it('denies update and delete on audit_events to every application role', async () => {
    const { rows } = await db.query<{ role: string; priv: string }>(`
      select r.rolname as role, p.privilege_type as priv
      from (values ('authenticated'), ('anon'), ('service_role')) as roles(rolname)
      join pg_roles r on r.rolname = roles.rolname
      cross join lateral (
        select unnest(array['UPDATE', 'DELETE']) as privilege_type
      ) p
      where has_table_privilege(r.rolname, 'public.audit_events', p.privilege_type)
    `);

    expect(rows).toEqual([]);
  });

  it('keeps every documents bucket private', async () => {
    const { rows } = await db.query<{ id: string; public: boolean }>(`
      select id, public from storage.buckets
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const bucket of rows) {
      expect(bucket.public).toBe(false);
    }
  });

  it('never lets a child row disagree with its parent about the tenant', async () => {
    // The composite foreign keys are what make this unrepresentable; this asserts they exist
    // rather than trusting that every child was written correctly.
    const { rows } = await db.query<{ table_name: string }>(`
      select distinct cl.relname as table_name
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public'
        and c.contype = 'f'
        and array_length(c.conkey, 1) > 1
    `);

    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [
        'case_access_grants',
        'cases',
        'documents',
        'reminder_deliveries',
        'requirements',
        'reviews',
        'staff_notifications',
      ].sort(),
    );
  });
});
