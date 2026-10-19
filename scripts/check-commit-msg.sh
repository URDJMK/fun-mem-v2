#!/bin/sh
# commit-msg hook: the first line follows Conventional Commits (see CONTRIBUTING.md).
#
#   type(scope): subject        type: subject        type(scope)!: subject  (breaking)
#
# Comment lines and blank lines before it are skipped (git strips them afterwards), and
# git's own merge, revert, fixup! and squash! subjects pass as they are.
first=$(awk '/^[[:space:]]*#/ || /^[[:space:]]*$/ { next } { print; exit }' "$1")

case "$first" in
  "Merge "* | "Revert "* | "fixup! "* | "squash! "* | "amend! "*) exit 0 ;;
esac

types='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
if printf '%s\n' "$first" | grep -Eq "^($types)(\([a-z0-9][a-z0-9._/-]*\))?!?: [^[:space:]]"; then
  exit 0
fi

cat >&2 <<MSG
commit message: the first line must look like "type(scope): subject", for example
  feat(api): undo keeps a memory someone linked to
  fix(web): keep the address after a failed sign-in
types: feat fix docs style refactor perf test build ci chore revert
got: $first
MSG
exit 1
