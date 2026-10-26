-- Two kinds of project, and invitations to one.
--
-- A project (an `archives` row) is either personal, about one person, or a family's, about
-- everyone in it. For a personal project `subject_name` is that person ("Grandma Nell"); for a
-- family one it is the family's name ("The Marsh family"), and the people in it are its person
-- notes, added as they are interviewed. Neither kind needs the people it records to have
-- accounts: accounts are the collaborators, and they join by invitation.

alter table public.archives
  add column kind text not null default 'personal'
  check (kind in ('personal', 'family'));

comment on column public.archives.subject_name is
  'personal: the one person the project is about; family: the family''s name';

-- An invitation to join a project with a role, addressed to one person: an account found by
-- searching, or an email address that has no account yet, waiting for whoever signs in with it.
-- The person sees it in Firepit and accepts or declines; nobody is put in a project without
-- saying yes. `revoked_at` withdraws it; past `expires_at` it is dead. The roles that can be
-- given are limited here as well as in the API: never owner, never the sponsor or minor roles.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  invitee_id uuid references auth.users (id) on delete cascade,
  invitee_email text check (invitee_email = lower(invitee_email)),
  role public.membership_role not null
    check (role in ('steward', 'contributor', 'viewer')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answer text check (answer in ('accepted', 'declined')),
  answered_at timestamptz,
  revoked_at timestamptz,
  check (invitee_id is not null or invitee_email is not null)
);
create index invites_archive_idx on public.invites (archive_id);
create index invites_invitee_idx on public.invites (invitee_id);
create index invites_email_idx on public.invites (invitee_email);
-- one open invitation per person per project
create unique index invites_one_open
  on public.invites (archive_id, coalesce(invitee_id::text, invitee_email))
  where answered_at is null and revoked_at is null;

-- Like every table here (see the initial schema): reached only through the API, which applies
-- the roles itself; row level security on, with no policy, so the data API reads nothing.
alter table public.invites enable row level security;
