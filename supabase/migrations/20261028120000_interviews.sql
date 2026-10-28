-- Interviews keep their transcript, and the import writes their stories from it
-- (docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md, 7.1).
--
-- Until now an import kept nothing of the transcript but the memories it made: every word the
-- narrator said had to end up in some memory, so greetings and one-line replies became notes of
-- their own. With the transcript kept here, a story holds only what is a story, and the words
-- that are not in one are still in the project. A row is written when an import starts, so a
-- transcript whose stories could not be written yet (the AI unavailable, the import stopped) is
-- kept, and its stories can be written later from it. Undoing the import that wrote its stories
-- deletes the row (the import keeps no words after an undo), and deleting the project deletes it.
--
-- API only, like every table here (ADR 0002): row security on, no grants.
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  created_by uuid not null,
  name text not null,
  recorded_at timestamptz not null default now(),
  -- the same hash as ingest_runs.source_hash: the transcript's words, whatever format they came in
  source_hash text not null,
  -- the transcript as it arrived (plain text, or JSON as text) and the options it came with
  -- (teller, speaker names, interviewees), so its stories can be written again from it
  transcript text not null,
  options jsonb not null default '{}'::jsonb,
  stories_status text not null default 'pending' check (stories_status in ('pending', 'written')),
  created_at timestamptz not null default now()
);
create index interviews_archive_idx on public.interviews (archive_id, created_at desc);
-- one waiting interview per transcript: bringing the same words in again picks it up
create unique index interviews_pending_hash_idx on public.interviews (archive_id, source_hash)
  where stories_status = 'pending';
alter table public.interviews enable row level security;

-- the import that wrote an interview's stories (its notes carry the revision reason 'import',
-- declared in the initial schema; the memory import keeps 'ai-suggestion')
alter table public.ingest_runs
  add column interview_id uuid references public.interviews (id) on delete set null;
