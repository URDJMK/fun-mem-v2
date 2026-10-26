-- Interview imports run as jobs (server/api/src/ingest-jobs.ts). They lived in one server
-- process's memory; a Cloudflare Worker is many isolates, and the request that starts a job,
-- the queue consumer that runs it and the requests that poll, cancel and save it may each land
-- in a different one. So a job is a row.
--
-- What a row holds, and for how long, is what the in-memory job held: the outcome (the
-- memories, which are the family's words) for as long as somebody is looking at it, at most
-- 3 hours for an unsaved preview, 15 idle minutes for anything else; then the row is deleted.
-- The raw transcript is held only while a job waits for a queue consumer (`request`), and is
-- cleared the moment the consumer picks it up. Undoing an import or erasing a note rewrites the
-- outcomes that quote them.
--
-- No foreign keys: a job may outlive the archive it was for by its few idle minutes, and the
-- limits in ingest-jobs.ts count rows the same way whether or not the archive is still there.
create table public.ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  -- every server instance of one deployment shares a scope, and the limits count within it
  scope text not null,
  archive_id uuid not null,
  user_id uuid not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  stage text not null check (stage in ('reading', 'organizing', 'checking', 'saving', 'done')),
  progress_done integer not null default 0,
  progress_total integer not null default 0,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- the last time its owner looked at it: a finished job lives on IDLE time
  touched_at timestamptz not null,
  -- the last sign of life from whatever is running it; a running job that goes quiet died
  heartbeat_at timestamptz not null,
  -- the request, transcript included, as JSON text while the job waits for a queue consumer;
  -- then null. Text, not jsonb: the transcript is not cleaned yet, and jsonb refuses a \u0000.
  request text,
  outcome jsonb,
  -- outcome->>'status', kept beside it so the limits can tell a preview without reading it
  outcome_status text,
  error jsonb,
  markers jsonb not null default '[]',
  saving boolean not null default false,
  timed_out boolean not null default false,
  cancel_requested boolean not null default false,
  -- what its outcome holds, roughly (its JSON length): the byte caps count this
  bytes integer not null default 0
);
create index ingest_jobs_scope_status_idx on public.ingest_jobs (scope, status);
create index ingest_jobs_scope_archive_idx on public.ingest_jobs (scope, archive_id);

comment on table public.ingest_jobs is
  'Interview import jobs, shared by every server instance. Holds the outcome only while somebody may still read it; see ingest-jobs.ts.';

-- Like every table here: reached only through the API (ADR 0002), so row level security is on
-- with no policy, and the default privileges already give anon and authenticated nothing.
alter table public.ingest_jobs enable row level security;
