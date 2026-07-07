#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:${BROWSER_SEARCH_PORT:-8088}}"
AUTH=()
if [[ -n "${BROWSER_SEARCH_API_KEY:-}" ]]; then
  AUTH=(-H "Authorization: Bearer ${BROWSER_SEARCH_API_KEY}")
fi

curl -fsS "$BASE_URL/healthz" | grep -q 'ok'
curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"query":"Model Context Protocol","maxResults":3}' "$BASE_URL/v1/search"
curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","backend":"auto","maxCharacters":5000}' "$BASE_URL/v1/fetch"

if [[ "${CRAWL4AI_ENABLED:-true}" != "false" ]]; then
  curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com","backend":"crawl4ai","query":"example domain","maxCharacters":5000}' "$BASE_URL/v1/fetch"
fi
printf '\nSmoke tests passed.\n'
