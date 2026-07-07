# Resilient Browser Search

A deterministic MCP and REST service for AI agents that need current public web content.

```text
web_search: SearXNG → browser search fallback (scrapes a search result page through the fetch chain)
web_fetch:  direct HTTP → optional Crawl4AI Markdown extraction → Camofox → CloakBrowser
```

Unlike the upstream skill-only workflow, fallback decisions happen in code. Every response identifies the backend, outcome, elapsed time, and complete attempt history.

## Security properties

- Public `http` and `https` URLs only.
- Blocks loopback, RFC1918, link-local, CGNAT, test, multicast, local IPv6, metadata hostnames, and internal TLDs.
- Direct HTTP pins each request to a DNS address that was validated before connection and revalidates every redirect.
- Crawl4AI is an optional private sidecar for query-aware Markdown extraction and is forced through the same DNS-pinning egress proxy.
- CloakBrowser uses the same DNS-pinning egress proxy as Camofox and also intercepts browser requests as defense in depth.
- Camofox has no direct internet network: all of its browser traffic is forced through a DNS-pinning egress proxy that rejects private and metadata destinations.
- No arbitrary JavaScript, cookies, proxy values, credentials, or browser profile paths are accepted from MCP callers.
- Authentication, subscriptions/paywalls, policy denial, and unresolved human verification are terminal outcomes.
- Services publish only the orchestrator on `127.0.0.1` by default; SearXNG, Camofox, and the filtering proxy remain private to Docker networks.

## Start locally

```bash
cp .env.example .env

# Generate values, then paste them into .env:
openssl rand -hex 32  # CAMOFOX_API_KEY (required)
openssl rand -hex 32  # CRAWL4AI_TOKEN (required when CRAWL4AI_ENABLED=true)
openssl rand -hex 32  # BROWSER_SEARCH_API_KEY (required for network deployments)

docker compose up -d --build
docker compose ps
./scripts/smoke-test.sh
```

The first build/start is large because the browser images include their runtime binaries. Camofox is attached only to an internal Docker network, and browser/extraction backends use the included DNS-pinning `egress-proxy` while still exiting through the host residential connection.

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


## Crawl4AI integration

Crawl4AI is integrated as a private extraction worker rather than a public MCP surface. The Node orchestrator still validates the original URL, owns redirect-sensitive policy decisions, normalizes the response, and records the full attempt history. The sidecar only receives URLs that passed the same public-URL admission checks used by the direct, Camofox, and CloakBrowser paths.

Default Compose behavior:

```text
browser-search ──control──> crawl4ai
crawl4ai ──HTTP proxy──> egress-proxy ──internet──> public web
```

Important knobs:

| Variable | Default | Purpose |
|---|---:|---|
| `CRAWL4AI_ENABLED` | `true` in Compose, `false` without Compose | Enables the `crawl4ai` backend in the auto chain |
| `CRAWL4AI_TOKEN` | required by Compose | Bearer token between orchestrator and sidecar |
| `CRAWL4AI_TIMEOUT_MS` | `45000` | Orchestrator-to-sidecar request timeout |
| `CRAWL4AI_PAGE_TIMEOUT_MS` | `45000` | Crawl4AI browser page timeout |
| `CRAWL4AI_MAX_SCROLL_STEPS` | `3` | Bounded page-scanning cap |
| `CRAWL4AI_SCAN_FULL_PAGE` | `false` | Enables bounded scroll scanning when needed |

Use it explicitly:

```bash
curl -s http://127.0.0.1:8088/v1/fetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","backend":"crawl4ai","query":"example domain"}' | jq
```

For `web_research`, the service automatically sets `preferCrawl4ai: true` and passes the research query to Crawl4AI. That gives BM25-filtered Markdown when the sidecar is available, while still falling back to direct HTTP content if Crawl4AI fails or is disabled.

## MCP tools

| Tool | Purpose |
|---|---|
| `web_search` | Search SearXNG and use browser search as a fallback |
| `web_fetch` | Retrieve a URL with deterministic escalation; supports explicit `backend: "crawl4ai"` and optional `preferCrawl4ai` for richer Markdown |
| `web_research` | Search and retrieve several independent sources |
| `web_health` | Check backend availability; deep mode probes enabled browser/extraction backends |

See `docs/clients.md` for Kilo, OpenCode, and Pydantic Deep configuration.

## Operational notes

- `CLOAK_PROXY` defaults to the internal `egress-proxy`; do not expose proxy selection to agents. Keep `CLOAK_GEOIP=false` for this local filtering proxy.
- A CloakBrowser Pro key is optional; set `CLOAKBROWSER_LICENSE_KEY` to use the current Pro binary.
- `Camofox` crash telemetry is disabled by the supplied Compose configuration.
- `Crawl4AI` is intentionally exposed only on an internal Docker network. Do not publish the sidecar port or allow MCP callers to send JavaScript, cookies, profile paths, proxy values, or domain-mapping requests.
- The Camofox Docker image fetches the Camoufox browser via a dedicated `camoufox-js fetch` build step and verifies it through `camoufox-js`' own resolver. The browser lives in camoufox-js' default per-user cache and is resolved from there at runtime. The image patches `camoufox-js` to skip GitHub prereleases, because the newest `daijro/camoufox` prerelease ships a fonts-only archive with no browser binary.
- SearXNG is an unmodified sidecar. Review and tune its engines for your network and acceptable-use requirements.
- The orchestrator binds to `127.0.0.1` by default; the Compose override publishes it on the host loopback. Set `HOST` explicitly and always set `BROWSER_SEARCH_API_KEY` when binding a non-loopback address.
- Optional features, all off by default: response caching (`CACHE_ENABLED`), per-peer rate limiting (`RATE_LIMIT_RPM` / `RATE_LIMIT_BURST`), and robots.txt enforcement (`ROBOTS_ENABLED`). Behind LiteLLM, multiple agents may share one peer address.
- PDF responses (`application/pdf`) are extracted to text by the direct backend.
- OpenMetrics are exposed at `/metrics`.

## Create a safe source archive

Do not zip the working directory directly because it may contain `.env`, `node_modules`, build output, and Git metadata. Use:

```bash
npm run package:source -- browser-search-resilient-source.zip
```

The command uses `git archive`, so only tracked source files are included.

## Upstream

This is a derivative implementation inspired by `Johell1NS/browser-search`. It retains the upstream MIT notice and replaces agent-directed shell orchestration with a typed MCP service.
