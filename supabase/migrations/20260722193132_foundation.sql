-- Foundation: the internal `app` schema and shared helpers.
--
-- `app` holds the authorization resolvers that RLS policies call. It is deliberately absent from
-- the API's exposed schema list (supabase/config.toml -> api.schemas), so nothing here is
-- reachable over PostgREST. Policies call these functions from inside Postgres, which needs no
-- API exposure.

create schema if not exists app;

-- Policy expressions are evaluated as the querying role, so the API roles need to resolve names
-- in `app` and execute the resolvers. Execute is granted per function, not blanket on the schema.
grant usage on schema app to authenticated, anon, service_role;

-- Postgres grants EXECUTE on every new function to PUBLIC. Nothing in `app` should be callable
-- by a role that was not handed it deliberately, so each function below and in later migrations
-- carries its own explicit revoke. There is no schema-wide shortcut that reliably covers
-- functions created later, so the guarantee is enforced by test instead: schema-guard.test.ts
-- fails if any `app` function is executable by `anon`.


-- Keeps `updated_at` honest without relying on every writer to remember it.
--
-- SECURITY INVOKER (the default): this touches only the row already being written, so it needs no
-- elevated privileges. Reserve SECURITY DEFINER for the authorization resolvers, where it is the
-- privilege boundary and is reviewed as such.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function app.set_updated_at() is
  'Trigger helper. Sets updated_at to now() on any UPDATE.';

-- Triggers fire regardless of the caller's EXECUTE privilege, so no role needs this one.
revoke all on function app.set_updated_at() from public;
