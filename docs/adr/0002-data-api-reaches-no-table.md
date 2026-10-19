# 0002 — the Supabase Data API reaches no table

Date: 2026-10-19 · Status: accepted

## Context

Supabase serves every table in `public` over its Data API (PostgREST and GraphQL) to anyone holding
a session token, filtered only by row-level security. v1 granted `authenticated` read and write on
most tables behind policies that checked membership alone: no roles, no private notes. Any member,
a read-only viewer too, could rewrite or delete memories and read another member's private note with
their own token. The app never used that door: the API connects as the table owner and applies
membership, roles and private notes itself.

## Decision

`anon` and `authenticated` get no privilege on any table, sequence or function in `public`, and
neither will future ones (default privileges). Every table keeps row-level security on, with no
policy, so a grant added by mistake later still reads and writes nothing. The browser uses Supabase
for signing in only; every read and write goes through the API.

## Consequences

- One door to the data, with one set of rules: `server/api`.
- `server/api/test/rls.test.ts` fails if a table, sequence or function becomes reachable, or a table
  loses row-level security; it also checks a member's real token against the REST API.
- A feature that wants the Data API (realtime subscriptions, a direct client query) needs a new ADR
  and role-aware policies first.
