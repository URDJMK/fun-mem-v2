# Contributing

## Once per clone

```sh
just setup
```

It installs the dependencies, the git hooks (gitleaks on what you stage; the commit message
check) and the commit message template.

## Branches

GitHub Flow: `main` is always green, and changes reach it only through a pull request.

- Branch from `main` as `<type>/<slug>`, with the same types as commits: `feat/ingest-retry`,
  `fix/web-sign-in-loop`, `docs/ingest-api`.
- Keep a branch short: merge it within a few days. Rebase it on `main` rather than merging `main`
  into it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.

- **types:** `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`
- **scopes** (optional): `api` `web` `core` `persona` `db` `ingest` `docs` `ci` `deps`
- the subject is imperative and short (about 72 characters, no full stop); the body says **why**
- a breaking change: `type(scope)!: subject`, and a `BREAKING CHANGE: …` line in the body

The commit-msg hook refuses anything else (git's own merge, revert and fixup messages pass).

## Secrets

- Real values live only in `.env`, which git ignores. `.env.example` lists the names, never values.
- gitleaks checks every commit (what is staged) and CI checks the whole history. `just
  secrets-scan` runs the whole-history check locally.
- If a secret is ever committed, **rotate it first**: once pushed, the old value must be treated as
  public. Then remove it from the history.
- Interview transcripts are a family's memories. Tests and demos use made-up ones or ones the family
  agreed to, and the AI step sends them to NVIDIA.

## Before a pull request

- `just check` passes: lint, formatting, types, tests. The server's tests need the local stack
  (`just db-up`).
- The pull request template is filled in, including how you checked the change.

## Reviews

Start a review comment with what kind it is:

- `blocking:` must change before merging
- `question:` needs an answer, not necessarily a change
- `nit:` optional

## Database changes

Add a new file, `supabase/migrations/<YYYYMMDDHHMMSS>_<what>.sql`. Never edit a migration that has
run anywhere. The Data API stays closed ([ADR 0002](docs/adr/0002-data-api-reaches-no-table.md)):
no grant to `anon` or `authenticated` without a new ADR.
