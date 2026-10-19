-- fun-mem v2: the whole schema in one migration.
--
-- This is fun_mem v1's schema as its eighteen migrations left it (through
-- 20261019170000), minus photographs (`public.media` and its policies). The comments
-- below keep the reasons each piece exists; the history behind them is in the v1
-- repository, where every one of these lines was a migration of its own.
--
-- ONE DELIBERATE CHANGE FROM v1: the Supabase Data API (PostgREST, and GraphQL) can
-- reach no table here. v1 granted `authenticated` select/insert/update/delete on most
-- tables behind member-scoped RLS policies, and those policies knew nothing of roles or
-- of private notes, so any member (a viewer too) could rewrite or delete memories and
-- read another member's private note with nothing but their own session token. The app
-- never used that door: the API connects as the table owner over its own pool and
-- applies the roles and the private-note rule itself. So no grant is given to `anon` or
-- `authenticated` on anything in `public`, row-level security is ON for every table
-- with NO policy (a grant added by mistake later still reads and writes nothing), and
-- the default privileges hand future tables nothing either. test/rls.test.ts pins it.

create extension if not exists vector with schema extensions;
-- honest Korean tokenization for search: '바다' matches '바다에', which the built-in
-- analyzers cannot do
create extension if not exists pgroonga with schema extensions;

-- ---------- enums ----------
create type public.membership_role as enum (
  'owner', 'steward', 'gifter', 'contributor', 'reviewer', 'viewer', 'minor_viewer', 'sponsor_admin'
);
create type public.entity_type as enum ('person', 'place', 'event', 'period', 'object', 'source');
create type public.note_class as enum ('testimony', 'entity');
create type public.consent_scope as enum (
  'storage', 'ai_processing', 'family_sharing', 'persona',
  'voice', 'likeness', 'public_sharing', 'commercial_use'
);
create type public.consent_state as enum ('granted', 'withdrawn');
create type public.audience_kind as enum ('private-to-author', 'archive-members');
create type public.archive_state as enum ('active', 'archived');
create type public.consent_class as enum ('self', 'third_party');

-- Why a revision exists. `rename-cascade` is the load-bearing one: a machine rewrite of
-- someone else's note must never read as that person editing their own words.
-- `erasure-cascade` is its sibling: a "may disagree with" line taken out because the
-- note it quoted was erased.
create type public.revision_reason as enum (
  'create',
  'edit',
  'rename-cascade',
  'restore',
  'import',
  'ai-suggestion',
  'erasure-cascade'
);

-- ---------- canonical tables ----------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'personal', -- 'personal' | 'sponsor'
  name text not null,
  created_at timestamptz not null default now()
);

create table public.archives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  subject_name text not null,        -- exactly one represented person
  jurisdiction text not null,        -- FR-128 schema column
  consent_class public.consent_class not null default 'self',
  state public.archive_state not null default 'active',
  created_at timestamptz not null default now()
);
create index archives_tenant_idx on public.archives (tenant_id);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  unique (archive_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);
create index memberships_archive_idx on public.memberships (archive_id);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  title text not null,
  type public.entity_type not null,
  note_class public.note_class not null default 'testimony',
  body text not null default '',
  occurred text,                     -- RAW fuzzy string, never coerced (FR-062)
  recorded timestamptz,
  revised timestamptz,
  contributors text[] not null default '{}',
  extra jsonb not null default '{}',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index notes_archive_idx on public.notes (archive_id);
-- OPERAND ORDER IS LOAD-BEARING. An expression index is matched on expression TEXT, and
-- every application query spells it exactly this way; a mismatch silently drops to a
-- sequential scan, which makes a large import quadratic.
create unique index notes_archive_title_ci
  on public.notes (archive_id, normalize(lower(btrim(title)), NFC));
comment on index public.notes_archive_title_ci is
  'FM-050: case-insensitive AND composition-insensitive unique title per archive. Mirrors normalizeTitle = trim().toLowerCase().normalize(NFC) — NFC LAST, matching this expression text so application queries can use this index.';

-- the append-only version log IS the history
create table public.revisions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes (id) on delete cascade,
  archive_id uuid not null references public.archives (id) on delete cascade,
  author uuid references auth.users (id),
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  -- deterministic newest-first order: created_at is transaction-start time and can tie;
  -- every append happens under the note's FOR UPDATE lock, so seq is write order per note
  seq bigint generated always as identity,
  reason public.revision_reason not null default 'edit',
  -- one id per logical action: a rename that rewrites 40 referrers is ONE change
  change_id uuid
);
create index revisions_note_idx on public.revisions (note_id);
create index revisions_archive_idx on public.revisions (archive_id);
create index revisions_note_seq_idx on public.revisions (note_id, seq desc);
-- the review UI and change-set undo both read history by change, not by row
create index revisions_change_id_idx on public.revisions (change_id)
  where change_id is not null;
comment on column public.revisions.reason is
  'Why this revision exists. Rows predating FM-039 carry the ''edit'' default and are permanently unlabelled — the append-only trigger forbids backfill.';
comment on column public.revisions.change_id is
  'Groups every revision written by one logical action (FM-039). Null for rows predating the column.';

-- the consent ledger (FR-120): who allowed what, for whom, in which version
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  person uuid not null,
  scope public.consent_scope not null,
  audience text not null,
  purpose text not null,
  version int not null,
  state public.consent_state not null default 'granted',
  created_at timestamptz not null default now()
);
create index consents_archive_idx on public.consents (archive_id);

create table public.links (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  source_id uuid not null references public.notes (id) on delete cascade,
  target text not null,              -- authored title (never a UUID in bodies)
  resolved_id uuid references public.notes (id) on delete set null,
  heading text,
  block_id text,
  embed boolean not null default false,
  start_pos int not null,            -- UTF-16 index
  end_pos int not null,
  snippet text not null
);
create index links_archive_idx on public.links (archive_id);
create index links_source_idx on public.links (source_id);
create index links_resolved_idx on public.links (resolved_id);
-- a new note claims the dangling links that name it with an index lookup, not a scan
-- (written exactly as the query writes it, so the planner can use it)
create index links_unresolved_target_idx
  on public.links (archive_id, normalize(lower(btrim(target)), NFC))
  where resolved_id is null;

-- who may read a note: no row = every member of the archive
create table public.audiences (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  kind public.audience_kind not null default 'archive-members',
  include_in_export boolean not null default true,
  unique (note_id)
);
create index audiences_archive_idx on public.audiences (archive_id);

create table public.tombstones (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null,          -- no FK: survives archive deletion
  subject_id uuid not null,
  kind text not null,                -- 'note' | ...
  deleted_at timestamptz not null default now(),
  -- deliberately holds NO content (FR-143): ids only
  deleted_by uuid
);
create index tombstones_archive_idx on public.tombstones (archive_id);

-- ---------- search: block-level chunks, full-text, vectors ----------
-- Every derived table references notes(id) ON DELETE CASCADE and archives(id) ON DELETE
-- CASCADE, so erasure (FR-143) takes it along: orphan embeddings are forbidden.
create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  -- (note, revision) provenance for staleness tracking (FR-044)
  revision_id uuid references public.revisions (id) on delete set null,
  chunk_index int not null,
  heading text not null default '',
  heading_path text[] not null default '{}',
  anchor text,                       -- authored ^block-id if the chunk has one
  start_pos int not null,            -- UTF-16 offsets into the note body
  end_pos int not null,
  content text not null,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  -- sha256 hex of the UTF-8 content, written by the app: unchanged text skips re-embedding
  content_hash text not null,
  unique (note_id, chunk_index)
);
create index chunks_archive_idx on public.chunks (archive_id);
create index chunks_note_idx on public.chunks (note_id);
create index chunks_fts_idx on public.chunks using gin (fts);
create index chunks_pgroonga_idx on public.chunks using pgroonga (content);
create index chunks_note_hash_idx on public.chunks (note_id, content_hash);
-- erasing a note must not scan every chunk once per revision it had
create index chunks_revision_idx on public.chunks (revision_id)
  where revision_id is not null;

-- keyed by CONTENT HASH + model_version, not chunk id: chunks are delete-and-reinserted on
-- every save. No HNSW index: the exact scan is what keeps the ACL filter exact.
create table public.chunk_embeddings (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  content_hash text not null,
  -- every vector records the model that produced it; cross-model cosine is meaningless
  model_version text not null,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  unique (note_id, content_hash, model_version),
  constraint chunk_embeddings_dims check (extensions.vector_dims(embedding) = 1024)
);
create index chunk_embeddings_archive_idx on public.chunk_embeddings (archive_id);
create index chunk_embeddings_note_hash_idx on public.chunk_embeddings (note_id, content_hash);

-- poison-chunk isolation: one chunk the provider always refuses must not stall the queue
create table public.chunk_embedding_failures (
  archive_id uuid not null references public.archives (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  content_hash text not null,
  model_version text not null,
  fail_count int not null default 1,
  last_tried timestamptz not null default now(),
  -- a CODE, never the provider's error string: that string can echo note text
  reason_code text not null,
  primary key (note_id, content_hash, model_version)
);
comment on table public.chunk_embedding_failures is
  'FM-046: per-chunk embedding failure bookkeeping. Content-free by construction — reason_code only, never a provider message. A row here parks a chunk from the embedding queue; it is cleared for free when the content changes (content_hash rotates) or the model changes (model_version rotates).';
create index chunk_embedding_failures_archive_idx
  on public.chunk_embedding_failures (archive_id);

-- ---------- interview imports ----------
-- One row per successful import: refuses a duplicate import and undoes an import as a
-- unit. Content-free once undone or emptied: a hash and a file name go, ids and counts stay.
create table public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  created_by uuid not null,
  -- a hash of the transcript's WORDS (not its file format)
  source_hash text,
  -- the uploader's own name for it (a file name); display only, may be null
  source_label text,
  -- the id every revision of that import carries
  change_id uuid not null,
  note_count int not null check (note_count >= 0),
  created_at timestamptz not null default now(),
  -- an import taken back as a unit: its (unedited) notes were erased
  undone_at timestamptz,
  -- "the newest live import of this interview", one per interview
  active boolean not null default true,
  constraint ingest_runs_active_has_hash check (not active or source_hash is not null)
);
comment on table public.ingest_runs is
  'One row per successful interview import. Content-free: a hash, a count and a file name. Lets the API refuse a duplicate import and undo an import as a unit.';
comment on column public.ingest_runs.source_hash is
  'A hash of the transcript''s words. NULL once the import is undone or its notes are all gone (FR-143).';
comment on column public.ingest_runs.source_label is
  'The uploader''s own name for the file; display only. NULL once the import is undone or its notes are all gone (FR-143).';
-- the duplicate guard: one ACTIVE import per interview per archive
create unique index ingest_runs_active_source_idx
  on public.ingest_runs (archive_id, source_hash)
  where active;
create index ingest_runs_archive_idx on public.ingest_runs (archive_id, created_at desc);
create index ingest_runs_hash_idx
  on public.ingest_runs (archive_id, source_hash)
  where source_hash is not null;
-- the scrub trigger looks an import up by the change id its notes carry
create index ingest_runs_change_idx on public.ingest_runs (change_id);

-- ---------- triggers ----------
-- The revision log is append-only for EVERY role, postgres included. The one door:
-- DELETE passes inside a transaction that set the transaction-local `funmem.erasure`
-- flag (the API's erasure path, FR-143); UPDATE never passes.
create function public.revisions_no_mutate()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and coalesce(current_setting('funmem.erasure', true), '') = 'on' then
    return old;
  end if;
  raise exception 'revisions are append-only (FM-013 4.6)';
end;
$$;
create trigger revisions_append_only
  before update or delete on public.revisions
  for each row execute function public.revisions_no_mutate();

create schema if not exists private;

-- The moment the LAST note of an import is erased, by whatever path, the import record
-- keeps no trace of what it was (FR-143). Every erased note's history passes through
-- `revisions`, so the rule lives here rather than in each erasure path.
create function private.ingest_runs_scrub_emptied()
returns trigger
language plpgsql
-- runs as the owner: whoever erased the note may hold no right on this bookkeeping table
security definer
set search_path = ''
as $$
begin
  update public.ingest_runs r
     set active = false, source_label = null, source_hash = null
   where r.change_id in (select distinct g.change_id from gone g where g.change_id is not null)
     and (r.active or r.source_label is not null or r.source_hash is not null)
     and not exists (select 1 from public.revisions v
                      where v.change_id = r.change_id and v.archive_id = r.archive_id);
  return null;
end;
$$;
revoke all on function private.ingest_runs_scrub_emptied() from public, anon, authenticated;
create trigger revisions_scrub_emptied_imports
  after delete on public.revisions
  referencing old table as gone
  for each statement
  execute function private.ingest_runs_scrub_emptied();

-- ---------- the Data API reaches nothing (see the header) ----------
alter table public.tenants enable row level security;
alter table public.archives enable row level security;
alter table public.memberships enable row level security;
alter table public.notes enable row level security;
alter table public.revisions enable row level security;
alter table public.consents enable row level security;
alter table public.links enable row level security;
alter table public.audiences enable row level security;
alter table public.tombstones enable row level security;
alter table public.chunks enable row level security;
alter table public.chunk_embeddings enable row level security;
alter table public.chunk_embedding_failures enable row level security;
alter table public.ingest_runs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- ...and the next migration's tables, sequences and functions inherit nothing either
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
