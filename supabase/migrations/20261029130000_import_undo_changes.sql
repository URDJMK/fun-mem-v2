-- Import undo restores are bookkeeping, not a person building on a linked note.
-- Keep their action id so future undos can tell them from a manual history restore.
alter table public.ingest_runs add column if not exists undo_change_id uuid;
create index if not exists ingest_runs_undo_change_idx on public.ingest_runs (archive_id, undo_change_id)
  where undo_change_id is not null;
comment on column public.ingest_runs.undo_change_id is
  'The undo action whose restore revisions must not count as later human link evidence.';
