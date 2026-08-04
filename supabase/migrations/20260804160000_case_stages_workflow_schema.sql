-- supabase/migrations/20260804160000_case_stages_workflow_schema.sql
--
-- Schema for the Case Stages sequential workflow. See
-- docs/superpowers/specs/2026-08-04-case-stages-workflow-design.md for the full design. This file
-- only adds columns/constraints; advance_case_stage, reopen_requirement, assign_requirement_stage,
-- and the reminder-selector rewrite are their own, later-numbered migrations.

-- ---------------------------------------------------------------------------------------------
-- blueprint_stages: completion_mode, cloned once into case_stages, never live-synced afterward
-- ---------------------------------------------------------------------------------------------

alter table public.blueprint_stages
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual'));

comment on column public.blueprint_stages.completion_mode is
  'requirements: stage completes when every client-visible requirement in it is satisfied. manual:
   staff confirms explicitly. Cloned into case_stages.completion_mode at Case creation; editing a
   Blueprint afterward never changes an already-cloned Case (existing project-wide rule).';

-- ---------------------------------------------------------------------------------------------
-- case_stages: sequencing state
-- ---------------------------------------------------------------------------------------------

alter table public.case_stages
  add column status text not null default 'locked'
    check (status in ('locked', 'active', 'completed')),
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual')),
  add column activated_at timestamptz,
  add column completed_at timestamptz,
  add column completed_by_auth_user_id uuid references auth.users (id) on delete set null;

comment on column public.case_stages.status is
  'locked -> active -> completed. Exactly one active stage per Case, enforced by
   case_stages_one_active_per_case below. No direct locked -> completed or backward transition.';

-- At most one active stage per Case. This is the workflow's core invariant — advance_case_stage
-- (Task 3) relies on it existing at the database level, not merely in application code.
create unique index case_stages_one_active_per_case
  on public.case_stages (case_id) where status = 'active';

-- ---------------------------------------------------------------------------------------------
-- requirements: reopening is a NEW ROW (supersede), never a status mutation on the approved one
-- ---------------------------------------------------------------------------------------------

alter table public.requirements
  add column reopened_from_requirement_id uuid references public.requirements (id) on delete set null,
  add column reopen_reason text check (reopen_reason is null or length(reopen_reason) <= 1000);

comment on column public.requirements.reopened_from_requirement_id is
  'Set only on a row created by reopen_requirement (Task 4). Points at the original, now-superseded
   requirement whose approval this row corrects. "Pending reopened requirement" (used by the
   advance-stage gate and the reminder selector) means: reopened_from_requirement_id is not null
   and status = ''outstanding''.';
