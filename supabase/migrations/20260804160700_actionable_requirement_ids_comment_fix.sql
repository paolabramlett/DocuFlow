-- supabase/migrations/20260804160700_actionable_requirement_ids_comment_fix.sql
--
-- Corrects app.actionable_requirement_ids's own comment: it used to say src/features/
-- reminders/send.ts independently recomputed a flat, stage-unaware outstanding-count "for a
-- future follow-up" — that follow-up landed in 20260804160600_case_state_gates.sql (send.ts now
-- calls public.list_actionable_requirement_ids instead of reimplementing the predicate). Leaving
-- the old comment in place would document a gap in the production catalog that no longer exists.

comment on function app.actionable_requirement_ids(uuid) is
  'The one shared definition of "actionable now" for a Participant''s Requirements, used by both
   app.eligible_reminders() and sendManualReminder (application layer) for deciding WHO gets a
   reminder, and by src/features/reminders/send.ts (via the public.list_actionable_requirement_ids
   wrapper) for the reminder email body''s outstanding-count — never reimplemented as a second,
   independent predicate anywhere in this codebase.';
