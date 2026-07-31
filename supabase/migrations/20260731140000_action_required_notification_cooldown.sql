-- Tracks the last time a participant was emailed about a review decision requiring their action
-- (today: a rejection; the column and its cooldown are named for the general rule — "does this
-- transition require the client to do something" — not the one case that currently satisfies it,
-- so a future transition like "needs additional info" only needs a new predicate, not a new
-- column or a new send path).
--
-- Kept on the grant, same reasoning as otp_last_sent_at a few lines up: the grant is already the
-- thing this notification is about, and a cooldown that outlived the grant would serve no one.
alter table public.case_access_grants
  add column action_required_notified_at timestamptz;

comment on column public.case_access_grants.action_required_notified_at is
  'Last time this participant was emailed about a requirement needing their action. A short cooldown after this timestamp coalesces a burst of rejections (e.g. a reviewer rejecting five documents in a row) into one email instead of five near-identical ones — the email itself reports the current total count, not just the one decision that triggered it.';
