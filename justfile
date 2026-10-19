# Run `just` with no arguments to list the recipes.

# .env (git-ignored) feeds `supabase start` (the Google sign-in keys) and the API
set dotenv-load := true

default:
    @just --list

# Install dependencies and the git hooks (once per clone)
setup:
    pnpm install
    pre-commit install --hook-type pre-commit --hook-type commit-msg
    git config commit.template .gitmessage

# Start the local Supabase stack and apply the migrations (stop v1's stack first: same ports)
db-up:
    supabase start

# Stop the stack. The database volume survives this; db-reset wipes it.
db-down:
    supabase stop

# Wipe this repository's local database and apply the migrations again
db-reset:
    supabase db reset

# URLs and keys of the running stack
db-status:
    supabase status

# The API on http://127.0.0.1:8788 (the web app proxies /v1 to it)
api:
    pnpm --filter @funmem/api start

# The web app on http://127.0.0.1:3000 (use 127.0.0.1, not localhost: sign-in is per address)
web:
    pnpm --filter @funmem/web dev --host 127.0.0.1

# Every test (the server's need the local stack: just db-up)
test:
    pnpm test

# What CI checks: lint, formatting, types, tests
check:
    pnpm lint
    pnpm format
    pnpm typecheck
    pnpm test

# Rewrite formatting in place
fmt:
    pnpm exec prettier --write .

# Audit the FULL commit history for leaked secrets (the hook only checks what is staged)
secrets-scan:
    gitleaks git . --config .gitleaks.toml --redact --no-banner -v

# Known vulnerabilities in the dependencies the app ships
audit:
    pnpm audit --prod
