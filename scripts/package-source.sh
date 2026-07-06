#!/bin/sh
set -eu

output="${1:-browser-search-resilient-source.zip}"
repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_root"

if [ -n "$(git status --porcelain)" ]; then
  echo 'Working tree is not clean; commit or stash changes before packaging.' >&2
  exit 1
fi

# git archive includes only tracked files, so .env, node_modules, dist, and .git
# cannot accidentally leak into a source bundle.
git archive --format=zip --prefix=browser-search-resilient/ --output="$output" HEAD
printf 'Created %s\n' "$output"
