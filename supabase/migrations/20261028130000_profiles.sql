-- The protagonist's profile (docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md,
-- D13 and 7.5). A personal project is about one person: this points at their person note, whose
-- `extra.profile` holds when they were born and died and what the family calls them. Every AI step
-- that writes or checks a story reads it (D14). A family project has none: each narrator's own
-- person note carries their profile.
alter table public.archives
  add column subject_note_id uuid references public.notes (id) on delete set null;
