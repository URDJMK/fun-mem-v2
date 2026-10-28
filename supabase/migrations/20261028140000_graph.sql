-- The people, places and things graph (docs/superpowers/specs/2026-10-28-people-places-graph-design.md).
-- A graph apart from notes: entities with aliases, what each story says about them (mentions),
-- and the relationships the interviews tell. An entity may point at a note written about it.
-- Mention and relationship rows are only ever added or deleted; an import's rows carry its run.

create type public.graph_entity_type as enum ('person', 'place', 'thing');

create table public.graph_entities (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  type public.graph_entity_type not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  -- matchKey(name) in @funmem/core: case, punctuation and a leading "the" ignored
  match_key text not null check (match_key <> ''),
  note_id uuid unique references public.notes (id) on delete set null,
  -- its lines from the stories every member can see, joined (an AI summary comes with Ask)
  description text not null default '',
  created_by uuid not null,
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (archive_id, type, match_key)
);
create index graph_entities_archive_idx on public.graph_entities (archive_id);
comment on table public.graph_entities is
  'A person, place or thing in a project''s stories. One per name (and type); a note about it is optional.';

create table public.graph_aliases (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  entity_id uuid not null references public.graph_entities (id) on delete cascade,
  alias text not null check (length(btrim(alias)) between 1 and 200),
  match_key text not null check (match_key <> ''),
  unique (archive_id, match_key)
);
create index graph_aliases_entity_idx on public.graph_aliases (entity_id);
comment on table public.graph_aliases is
  'Other names of an entity: real names and nicknames, and an old name kept after a rename. Never family words ("Dad"), which mean someone different to each speaker.';

create table public.graph_mentions (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  entity_id uuid not null references public.graph_entities (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  -- the words the story uses for it ("his mother"), which the story page underlines
  words text[] not null default '{}',
  -- one sentence on what this story says about it
  line text not null default '',
  -- [{ interviewId, from, to }] interview lines, or [{ noteId, sentence }] for a story without one
  sources jsonb not null default '[]',
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_id, note_id)
);
create index graph_mentions_note_idx on public.graph_mentions (note_id);
create index graph_mentions_archive_idx on public.graph_mentions (archive_id);
comment on table public.graph_mentions is
  'An entity named in a story: the words used and what the story says about it. Visible to whoever can see the story.';

create table public.graph_relationships (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  a_id uuid not null references public.graph_entities (id) on delete cascade,
  b_id uuid not null references public.graph_entities (id) on delete cascade,
  -- "Sarah Lee — Noah's friend from school": the direction is in the words
  description text not null check (length(btrim(description)) between 1 and 500),
  note_id uuid not null references public.notes (id) on delete cascade,
  sources jsonb not null default '[]',
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  check (a_id <> b_id)
);
-- one relationship per pair per story, whichever way round it was told
create unique index graph_relationships_pair_story_idx
  on public.graph_relationships (least(a_id, b_id), greatest(a_id, b_id), note_id);
create index graph_relationships_archive_idx on public.graph_relationships (archive_id);
create index graph_relationships_a_idx on public.graph_relationships (a_id);
create index graph_relationships_b_idx on public.graph_relationships (b_id);
comment on table public.graph_relationships is
  'A relationship a story tells between two entities. Being in the same story is not one.';

create table public.graph_changes (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  -- not a foreign key: the record outlives an entity that was removed or merged away
  entity_id uuid,
  kind text not null
    check (kind in ('rename', 'type', 'merge', 'remove', 'remove-relationship', 'note')),
  before jsonb not null default '{}',
  after jsonb not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index graph_changes_entity_idx on public.graph_changes (entity_id);
create index graph_changes_archive_idx on public.graph_changes (archive_id, created_at desc);
comment on table public.graph_changes is
  'Who changed the graph by hand, and when. An import''s undo spares an entity someone has changed.';

-- the API connects as the table owner and applies the visibility rules in every query; RLS
-- closes the tables to every other role, as for the other tables
alter table public.graph_entities enable row level security;
alter table public.graph_aliases enable row level security;
alter table public.graph_mentions enable row level security;
alter table public.graph_relationships enable row level security;
alter table public.graph_changes enable row level security;

-- the project's notes were turned into entities (once, in code, the first time its graph is read)
alter table public.archives add column graph_backfilled_at timestamptz;

-- a run that only builds the graph from saved stories makes no notes (note_count 0)
alter table public.ingest_runs add column kind text not null default 'import'
  check (kind in ('import', 'graph'));
