# Resilient Browser Search

A deterministic MCP and REST service for AI agents that need current public web content.

```text
web_search: SearXNG → browser search fallback (scrapes a search result page through the fetch chain)
web_fetch:  direct HTTP → Camofox → CloakBrowser
```

Unlike the upstream skill-only workflow, fallback decisions happen in code. Every response identifies the backend, outcome, elapsed time, and complete attempt history.

## Security properties

- Public `http` and `https` URLs only.
- Blocks loopback, RFC1918, link-local, CGNAT, test, multicast, local IPv6, metadata hostnames, and internal TLDs.
- Direct HTTP pins each request to a DNS address that was validated before connection and revalidates every redirect.
- CloakBrowser intercepts browser requests and blocks destinations that resolve to internal addresses.
- Camofox has no direct internet network: all of its browser traffic is forced through a DNS-pinning egress proxy that rejects private and metadata destinations.
- No arbitrary JavaScript, cookies, proxy values, credentials, or browser profile paths are accepted from MCP callers.
- Authentication, subscriptions/paywalls, policy denial, and unresolved human verification are terminal outcomes.
- Services publish only the orchestrator on `127.0.0.1` by default; SearXNG, Camofox, and the filtering proxy remain private to Docker networks.

## Start locally

```bash
cp .env.example .env

# Generate values, then paste them into .env:
openssl rand -hex 32  # CAMOFOX_API_KEY (required)
openssl rand -hex 32  # BROWSER_SEARCH_API_KEY (recommended)

docker compose up -d --build
docker compose ps
./scripts/smoke-test.sh
```

The first build/start is large because Camofox and CloakBrowser download and cache browser binaries. Camofox is attached only to an internal Docker network and reaches public sites through the included `egress-proxy` service.

Endpoints:

- MCP: `http://127.0.0.1:8088/mcp`
- Health: `http://127.0.0.1:8088/healthz`
- Backend readiness: `http://127.0.0.1:8088/readyz`
- Metrics (OpenMetrics): `http://127.0.0.1:8088/metrics`
- REST search: `POST /v1/search`
- REST fetch: `POST /v1/fetch`
- REST research: `POST /v1/research`

## Test without an agent

```bash
curl -s http://127.0.0.1:8088/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"NVIDIA BCM deployment documentation","maxResults":5}' | jq

curl -s http://127.0.0.1:8088/v1/fetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","backend":"auto"}' | jq
```

When `BROWSER_SEARCH_API_KEY` is set, add `Authorization: Bearer <key>`.

## MCP tools

| Tool | Purpose |
|---|---|
| `web_search` | Search SearXNG and use browser search as a fallback |
| `web_fetch` | Retrieve a URL with deterministic escalation |
| `web_research` | Search and retrieve several independent sources |
| `web_health` | Check backend availability; optional deep CloakBrowser check |

See `docs/clients.md` for Kilo, OpenCode, and Pydantic Deep configuration.

## Operational notes

- Configure proxies only with `CLOAK_PROXY` on the server. Do not expose proxy selection to agents.
- A CloakBrowser Pro key is optional; set `CLOAKBROWSER_LICENSE_KEY` to use the current Pro binary.
- `Camofox` crash telemetry is disabled by the supplied Compose configuration.
- SearXNG is an unmodified sidecar. Review and tune its engines for your network and acceptable-use requirements.
- The orchestrator binds to `127.0.0.1` by default; the Compose override publishes it on the host loopback. Set `HOST` explicitly and always set `BROWSER_SEARCH_API_KEY` when binding a non-loopback address.
- Optional features, all off by default: response caching (`CACHE_ENABLED`), per-client rate limiting (`RATE_LIMIT_RPM` / `RATE_LIMIT_BURST`), and robots.txt enforcement (`ROBOTS_ENABLED`).
- PDF responses (`application/pdf`) are extracted to text by the direct backend.
- OpenMetrics are exposed at `/metrics`.

## Upstream

This is a derivative implementation inspired by `Johell1NS/browser-search`. It retains the upstream MIT notice and replaces agent-directed shell orchestration with a typed MCP service.
