# Infra & Dev Conventions Checklist

A stack-agnostic reference for the dev-infra conventions a real engineering
team uses. Copy this file into a new project's `docs/` folder on day one and
work through it deliberately — checking an item off should mean it's set up
in *this* project, not just that it's understood. Tool names in parentheses
are examples, not requirements; swap in whatever fits the stack.

> **fun-mem v2, 2026-10-19.** A ticked item is set up in this repository, and the line after the
> arrow says where. The repository is public (github.com/URDJMK/fun-mem-v2), and CI runs on every
> push to `main` and every pull request. Items left open are deliberate, with the reason after the
> arrow.

## 1. Secrets & security scanning

**Why:** a leaked credential is cheap to prevent and expensive to rotate
after the fact. `.gitignore` is not a security control — it only stops a
file from being staged in the first place; it does nothing for a file
already committed, a screenshot, or a key pasted into a chat window. Real
secrets belong only in a gitignored `.env`, never in `.env.example`, never in
a committed file however "temporary" it seems.

- [x] Pre-commit secret scan (gitleaks or trufflehog) —
      `.pre-commit-config.yaml`, `.gitleaks.toml`
      → gitleaks on staged changes; `.gitleaks.toml` allows only Supabase's two public local keys
- [x] Full-history secret audit as a repeatable command, run after clone and
      periodically (not just pre-commit, which only checks what's staged)
      → `just secrets-scan`, and a CI step on every pull request
- [x] `.env.example` (committed, documents shape) vs `.env` (gitignored,
      real values) split
- [x] Dependency vulnerability scanning: Dependabot/Renovate (any stack),
      `cargo audit`/`cargo deny` (Rust), `npm audit`/`osv-scanner` (JS),
      `pip-audit` (Python)
      → `.github/dependabot.yml` (weekly), `just audit` (`pnpm audit --prod`)
- [ ] SAST (static analysis for bug/vuln patterns, not just secrets): CodeQL
      or Semgrep in CI
      → not yet: free now that the repository is public, one switch away (Settings → Code
      security → CodeQL analysis, default setup)
- [ ] License compliance check (`cargo deny` covers this too, or
      `license-checker` for JS)
      → later

## 2. Commit & branch conventions

**Why:** consistent commit messages make changelogs and `git bisect`
tractable; short-lived branches keep `main` mergeable and CI signal fresh.

- [x] Conventional Commits (`type(scope): subject`, imperative, body
      explains *why*) via a local `git commit.template` (`.gitmessage`)
- [x] Commit message convention enforced (not just documented) via a
      `commit-msg` hook or CI check (commitlint, or a gitleaks-style
      pre-commit hook)
      → `scripts/check-commit-msg.sh` as a pre-commit `commit-msg` hook
- [ ] Changelog generated from commit history (git-cliff, or
      `semantic-release` in the JS ecosystem)
      → later, with the first release (§8)
- [x] Branch naming convention (e.g. `<type>/<slug>`) and a short max branch
      lifetime, documented in `CONTRIBUTING.md`

Three branching models worth knowing when deciding a project's policy:
**GitFlow** (permanent `develop` + `release`/`hotfix` branches — built for
shipping multiple supported versions at once, rarely needed for a
continuously-deployed service), **GitHub Flow** (branch off `main`, PR,
merge, deploy — `main` always deployable), **trunk-based** (same shape as
GitHub Flow but branches live under a day; anything unfinished hides behind
a feature flag instead of an unmerged branch).

> fun-mem v2 uses **GitHub Flow** ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## 3. Quality gates

**Why:** a check that only runs on someone's laptop isn't a check — it has
to run in CI to actually gate anything.

- [x] Lint + format enforced in CI (not just available locally): e.g.
      `cargo clippy -- -D warnings` + `cargo fmt --check` (Rust), ESLint +
      Prettier `--check` (JS/TS), `ruff` + `black --check` (Python)
      → `.github/workflows/ci.yml` (`pnpm lint`, `pnpm format`)
- [x] Type checking as a CI step: `tsc --noEmit`, `mypy`
      → `pnpm typecheck` in CI
- [ ] Test coverage threshold reported and gated in CI: `cargo llvm-cov` /
      `tarpaulin` (Rust), `c8`/`istanbul` (JS), `coverage.py` (Python)
      → later: the tests run in CI, but nothing measures coverage yet

## 4. CI/CD pipeline shape

**Why:** a standard stage order catches cheap failures (lint) before
expensive ones (build, deploy), and gives every project the same mental
model for "what does green mean here."

- [x] CI pipeline with the standard stage order: install → lint → typecheck
      → test → build → (deploy)
      → install → secret scan → lint → format → typecheck → test (with a Supabase stack) → build;
      no deploy yet
- [ ] Branch protection on `main`: required status checks, required review,
      no direct pushes
      → not yet: a GitHub setting (Settings → Branches), with CI as the required check
- [ ] Preview/staging deploy per PR (Vercel/Netlify-style, or a self-hosted
      equivalent)
      → later: nothing is deployed yet

## 5. PR & review hygiene

**Why:** templates and CODEOWNERS turn "remember to mention X" into
something the process enforces instead of something a reviewer has to recall.

- [x] PR template (`.github/pull_request_template.md`)
- [ ] Issue templates (`.github/ISSUE_TEMPLATE/`)
      → later
- [x] `CODEOWNERS` for auto-assigning reviewers by path
      → `.github/CODEOWNERS` (everything to @URDJMK for now)
- [x] A shared review-comment vocabulary (e.g. prefixing comments `nit:`,
      `blocking:`, `question:`) so authors know what's optional
      → [CONTRIBUTING.md](../CONTRIBUTING.md#reviews)

## 6. Repo hygiene & docs

**Why:** a new contributor's first ten minutes should be spent reading, not
guessing.

- [x] Root `README.md` — what the project is, how to run it, where to start
      reading
- [x] `CONTRIBUTING.md` — branching, commit, and secrets conventions in the
      project's own voice
- [x] `SECURITY.md` — how to report a vulnerability privately
- [x] ADRs for significant technical decisions (`docs/adr/`)

## 7. Local dev tooling: Docker + justfile

**Why:** a task runner turns "the five commands you need to remember" into
`just <tab>`, and a healthcheck-gated Compose service means "it's running"
and "it's ready" aren't silently conflated.

- [x] Task runner (justfile, Makefile, or npm scripts) covering the common
      local-dev commands
      → `justfile`
- [x] Docker Compose service(s) with healthchecks, not bare `depends_on`
      → the Supabase CLI plays this part: `supabase start` (`just db-up`) waits for every service's
      health check before it returns. No `docker-compose.yml` of our own.
- [x] Named volumes for anything that shouldn't be wiped by a container
      restart
      → the database lives in the `supabase_db_fun-mem-v2` volume; `just db-down` keeps it,
      `just db-reset` wipes it

Starter `justfile` — copy in, then swap `<service>` and `<db_name>` for the
real names; add recipes as the project actually needs them rather than
stubbing commands for code that doesn't exist yet:

```just
# Run `just` with no args to list recipes.
default:
    @just --list

# Start <service> in the background and block until it reports healthy.
<service>-up:
    docker compose up -d <service>
    docker compose exec <service> sh -c 'until pg_isready -U <user> -d <db_name>; do sleep 0.5; done'

# Stop the container. The named volume survives this —
# use <service>-reset instead if you actually want to wipe the data.
<service>-down:
    docker compose down

# Wipe the volume and start clean.
<service>-reset:
    docker compose down -v
    just <service>-up

# Follow the container's log stream. Ctrl-C detaches without stopping it.
<service>-logs:
    docker compose logs -f <service>

# Audit the FULL commit history for leaked secrets — deliberately broader
# than the pre-commit hook, which only checks what's staged right now.
secrets-scan:
    gitleaks detect --source . --config .gitleaks.toml -v
```

Starter `docker-compose.yml` service block — the healthcheck + named-volume
+ host-port-offset pattern, generalized:

```yaml
services:
  <service>:
    image: <image>:<pinned-tag>       # pin a version, don't float :latest
    restart: unless-stopped
    environment:
      <SERVICE>_USER: <user>
      <SERVICE>_PASSWORD: <password>  # local dev only — real secrets via .env
      <SERVICE>_DB: <db_name>
    ports:
      # Offset the host port so this never collides with a same-service
      # instance already listening on the default port locally.
      - "<host_port>:<container_port>"
    volumes:
      - <service>data:/var/lib/<service>/data
    healthcheck:
      test: ["CMD-SHELL", "<readiness-check-command>"]
      interval: 2s
      timeout: 3s
      retries: 10

volumes:
  <service>data:
```

A `depends_on: { <service>: { condition: service_healthy } }` on a
dependent service genuinely blocks it until the healthcheck passes — Compose
has a distinct "Waiting" state between "Started" and "Healthy," and the
dependent service isn't created until "Healthy" appears. A bare
`depends_on: [<service>]` with no condition only waits for "Started," which
races: the process can be running before it's ready to accept connections.

## 8. Release/ops (later-stage)

**Why:** worth knowing about even before a project needs them, so they're a
deliberate later decision rather than a surprise.

- [ ] Semantic versioning tied to changelog output (pairs naturally with
      git-cliff/semantic-release from §2)
- [ ] Structured logging / observability conventions (tracing spans, log
      levels) — relevant once there are real services to operate, not a
      single local dev database
