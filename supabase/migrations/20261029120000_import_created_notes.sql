-- A paragraph added to an existing note does not make that note the import's own.
-- Retire a run when its last created note is erased, even if its appended paragraphs remain.
create or replace function private.ingest_runs_scrub_emptied()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ingest_runs r
     set active = false, source_label = null, source_hash = null
   where r.change_id in (select distinct g.change_id from gone g where g.change_id is not null)
     and (r.active or r.source_label is not null or r.source_hash is not null)
     and not exists (select 1 from public.revisions v
                      where v.change_id = r.change_id and v.archive_id = r.archive_id
                        and v.seq = (select min(w.seq) from public.revisions w
                                      where w.note_id = v.note_id));
  return null;
end;
$$;
