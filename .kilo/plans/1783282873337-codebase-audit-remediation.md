# Resilient Browser Search — Codebase Audit & Remediation Roadmap

Scope: `browser-search-resilient` (TypeScript MCP/REST service). State at review: `npm run typecheck` clean, `npm test` = 20/20 passing. Findings are grouped by severity with `file:line` evidence and actionable fixes, followed by a sequenced execution task list.

---

## P0 — Security (fix first)

### S1. Service binds to all interfaces by default; contradicts documented security model
- **Evidence**: `src/config.ts:21` `host: process.env.HOST ?? '0.0.0.0'`. `src/http.ts:49` listens on that host. README §Security claims "publish only the orchestrator on `127.0.0.1` by default".
- **Risk**: `npm run dev` / bare `node dist/http.js` exposes MCP + REST on every interface with no auth when `BROWSER_SEARCH_API_KEY` is unset. Compose mitigates via `127.0.0.1:8088:8088` port mapping, but the default is unsafe.
- **Fix**: Default `HOST` to `127.0.0.1`; let Compose explicitly set `HOST=0.0.0.0` (it already does). Add a startup warning when `HOST` is non-loopback **and** `apiKey` is empty.

### S2. API-key comparison is not constant-time
- **Evidence**: `src/http.ts:17` `return value === \`Bearer ${config.apiKey}\`;`
- **Risk**: Timing side-channel on bearer token validation.
- **Fix**: Compare in constant time (e.g. `crypto.timingSafeEqual` over equal-length buffers after a length check; prefix with a random-length pad to mask length).

### S3. No per-client rate limiting
- **Evidence**: `src/http.ts` `preHandler` only checks auth. `src/orchestrator.ts:10-11` semaphores bound concurrency but a single client can flood the queue and starve others, and endlessly spawn CloakBrowser processes (P2).
- **Fix**: Add a token-bucket per peer (keyed by remote IP / bearer) in `preHandler`, configurable via env (`RATE_LIMIT_RPM`, `RATE_LIMIT_BURST`). 429 on exceed.

### S4. REST endpoints lack request validation → 500s and unbounded input
- **Evidence**: `src/http.ts:32-43` casts `request.body as any` and passes straight to orchestrators. No schema. Missing `query`/`url` throws an unhandled error → Fastify 500. MCP tools are zod-validated (`src/mcp.ts`), REST is not.
- **Fix**: Reuse the same zod schemas for `/v1/search`, `/v1/fetch`, `/v1/research` (parse body; return 400 on failure). Also set an explicit Fastify `bodyLimit`.

### S5. SSRF blocklist gaps (IPv6 + cloud metadata hostnames)
- **Evidence**: `src/security/url.ts:65-72` IPv6 blocking uses `startsWith('fe8'|'fe9'|'fea'|'feb'|'fc'|'fd'|'ff')`. Missing: site-local `fec0::/10`, documentation `2001:db8::/32`, discard `100::/64`, NAT64 `64:ff9b:1::/48`. `BLOCKED_HOSTS` (lines 20-27) only covers Google + Alibaba metadata hostnames.
- **Risk**: Hostname-based rebinding to cloud metadata services whose IPs aren't link-local (e.g. Azure IMDS is 169.254.x — blocked by IP — but GCP/AWS service hostnames vary).
- **Fix**: Replace hex-prefix hacks with proper `BigInt` IPv6 CIDR matching mirroring `inCidr4`. Extend `BLOCKED_HOSTS` with the common IMDS hostnames (`metadata`, `metadata.google.internal`, `169.254.169.254`, `instance-data`, etc.) and add unit tests for each gap.

---

## P1 — Correctness & Reliability

### C1. CloakBrowser launches a new browser process per request (no pool)
- **Evidence**: `src/backends/cloakbrowser.ts:34` `browser = await launch({...})` on every call; closed in `finally`.
- **Impact**: High latency/CPU; throughput capped well below `browserConcurrency`.
- **Fix**: Maintain a lazy singleton browser + a small context pool reused across requests, recycling on crash. Keep per-request `route()` isolation via fresh contexts from the pool.

### C2. Charset detection is binary (utf8 vs latin1)
- **Evidence**: `src/backends/direct.ts:109-110` only honors `charset=iso-8859-1`. Pages served without a charset header but declaring `<meta charset="gbk">`/`shift_jis` are mis-decoded.
- **Fix**: Parse `<meta charset>` / `<meta http-equiv content-type>` as a fallback, and decode via `iconv` (add dependency) when non-utf8. At minimum detect and label a `decode_warning` when the declared charset is non-utf8 but unsupported.

### C3. `htmlToText` is regex-only and lossy
- **Evidence**: `src/util/text.ts:26-35`. No `<pre>`/whitespace preservation, tables flattened, malformed/nested comments and CDATA mishandled, no `<script type=...>` edge cases.
- **Fix**: Adopt a small tolerant HTML parser (e.g. `parse5` + tree-walk) for text + link extraction, keeping the deterministic whitespace normalizer. Gate behind the same `truncate` path.

### C4. Camofox uses a fixed 1000 ms wait
- **Evidence**: `src/backends/camofox.ts:74` `await new Promise(resolve => setTimeout(resolve, 1000));`.
- **Fix**: Poll the evaluate/snapshot until `document.readyState === 'complete'` or `networkidle` signal (or reuse `challengeWaitMs` loop pattern from cloakbrowser).

### C5. `webSearch` browser fallback ignores search options
- **Evidence**: `src/orchestrator.ts:72` hardcodes `https://www.google.com/search?q=...&num=...`; ignores `language`, `categories`, `timeRange`. README claims "Camofox search" as the fallback, not Google scraping.
- **Fix**: Pass `&hl=`/`&lr=` for language and `&tbs=qdr:` for timeRange. Better: route fallback through SearXNG with a different engine set, or document the Google-scrape behavior accurately and dedupe against the SearXNG attempt. Remove the misleading README line.

### C6. Health deep check contends with real traffic
- **Evidence**: `src/orchestrator.ts:122` `webFetch(...)` acquires `browserSemaphore`.
- **Fix**: Allow `/readyz` to use a reserved "health" concurrency slot or bypass the semaphore with its own tight timeout so monitoring can't be starved.

### C7. Shutdown does not drain in-flight browser/Camofox tabs
- **Evidence**: `src/http.ts:51-57` closes server immediately. Camofox tabs created mid-flight leak.
- **Fix**: Track outstanding tab IDs / browser contexts in a registry; on SIGTERM, await their `finally` cleanup (bounded wait) before `process.exit`.

---

## P2 — Performance / Scalability

- **P2.1 No caching**: every `web_fetch`/`web_search` hits the network. Add a TTL cache (search results short TTL; fetch keyed by URL+maxCharacters, honoring `Cache-Control`). (`src/orchestrator.ts`)
- **P2.2 No retry/backoff within a backend** for transient network errors; only cross-backend escalation exists. Add bounded retry with jitter in `fetchDirect` for connection resets.
- **P2.3 `extractLinks` + `htmlToText` run over full body even when only `maxCharacters` of text is needed** — large HTML is fully parsed before truncation. Stream/truncate the source first.

---

## P3 — Missing Features

| ID | Feature | Rationale / Anchor |
|---|---|---|
| F1 | **Observability**: structured JSON request logs + request IDs across the orchestrator/backends (only `egress-proxy` logs today) | `src/http.ts`, `src/orchestrator.ts` have no logging |
| F2 | **Metrics** (`/metrics` OpenMetrics): request count/latency/outcomes per backend, semaphore wait time | enables the reliability story the README implies |
| F3 | **PDF / binary text extraction**: agents frequently need PDFs; currently `unsupported_content_type` (`src/classifier.ts:86`) | add `pdf-parse`/`unpdf` for `application/pdf` |
| F4 | **robots.txt awareness**: fetch ignores robots entirely | ethical + compliance; at least honor `Disallow` for the `direct` backend |
| F5 | **Response headers passthrough**: `FetchAttempt` only keeps `contentType`; expose a curated header map | `src/types.ts:21-35` |
| F6 | **SearXNG category/timeRange validation** | `src/search/searxng.ts:21-22` passes through unvalidated |
| F7 | **Egress-proxy health in `/readyz`** | `src/orchestrator.ts:107` omits the proxy Camofox depends on |

---

## P4 — Code Quality / Tooling

- **Q1. Test coverage is thin**: only `url`, `classifier`, `direct` lookup, and one SSRF orchestrator test. No tests for `searxng`, `webSearch`/`webResearch` orchestration, MCP schema wiring, REST auth/validation, semaphore fairness, or `text.ts` parsing edge cases. → Add unit + integration (mock fetch) tests.
- **Q2. `tests/` not type-checked**: `tsconfig.json:19` `include: ["src/**/*.ts"]`; `npm run typecheck` skips tests. → Add a `tsconfig.test.json` or include `tests/**`, add `pretest` typecheck.
- **Q3. Pervasive `any` in HTTP layer**: `src/http.ts:20-47` uses `any` for request/reply. → Use Fastify `FastifyInstance`/route generics.
- **Q4. No linter/formatter**: no eslint/prettier config. → Add eslint (typescript-eslint) + prettier, wire `lint` script.
- **Q5. No CI**: no `.github/workflows`. → Add workflow running typecheck, lint, test, and Docker build.
- **Q6. Inconsistent org naming**: package `@actual-human`, Docker image `actualhuman/...`, user-agent URL `github.com/Actu4l-Human` (`src/config.ts:53`, likely a typo). → Pick one canonical org and fix the user-agent URL.
- **Q7. `package.json` publish hygiene**: `private: false`, no `files` allowlist, no `prepublishOnly`, no `bin`. → Either set `private: true` or add `files` + `prepublishOnly`.
- **Q8. `numberEnv`/`boolEnv` swallow bad input silently** (`src/config.ts:1-12`) — invalid values fall back to defaults with no warning. → Warn on parse failure.
- **Q9. ` cloakbrowser`/`camofox` backends not exercised in tests** — extract a `fetchJson`/`launch` seam to enable mocking.

---

## Remediation Roadmap (execution order)

Hand-off-ready task list. Each task is independently shippable.

### Phase A — Harden security (P0)
1. **S1** Set `HOST` default to `127.0.0.1` in `src/config.ts`; add startup warning when non-loopback + no API key; update README to match. Keep Compose override `HOST=0.0.0.0`.
2. **S2** Constant-time bearer check in `src/http.ts` `authorized()`; add unit test.
3. **S4** Extract zod input schemas to `src/schemas.ts`; import in both `src/mcp.ts` and `src/http.ts`; return 400 on invalid REST bodies; set Fastify `bodyLimit`.
4. **S5** Replace IPv6 `startsWith` blocking with `BigInt` CIDR matching in `src/security/url.ts`; expand `BLOCKED_HOSTS`; add parametrized tests for every gap prefix/hostname.
5. **S3** Implement token-bucket rate limiter middleware (in-memory, per peer) with `RATE_LIMIT_RPM`/`RATE_LIMIT_BURST` config; 429 responses; test.

### Phase B — Correctness & reliability (P1)
6. **C1** CloakBrowser browser/context pool with crash recycling; keep per-request `route()` isolation.
7. **C2** Meta-charset fallback + non-utf8 decode path (add `iconv-lite`); tests for gbk/shift_jis samples.
8. **C3** Swap regex `htmlToText`/`extractLinks` for a tolerant parser (`parse5`); regression tests against the existing fixtures.
9. **C4** Polling readyState in Camofox instead of fixed 1000 ms; configurable cap.
10. **C5** Pass language/timeRange to the browser search fallback; correct README's "Camofox search" wording.
11. **C6** Reservation/bypass slot for `/readyz` deep checks.
12. **C7** Outstanding-request registry + bounded drain on SIGTERM.

### Phase C — Performance (P2)
13. **P2.1** TTL cache module (search + fetch) honoring `Cache-Control`; `CACHE_TTL_MS` config; test.
14. **P2.2** Jittered retry within `fetchDirect` for transient connection errors only.
15. **P2.3** Truncate source HTML before expensive parsing.

### Phase D — Features (P3, pick by need)
16. **F1** Structured logging + request ID propagation.
17. **F2** `/metrics` (OpenMetrics) endpoint.
18. **F3** PDF text extraction for `application/pdf`.
19. **F4** robots.txt fetcher + `direct` backend honoring.
20. **F5/F6/F7** Header map, category validation, egress-proxy readiness.

### Phase E — Quality & tooling (P4)
21. **Q2** Type-check tests; `pretest` script.
22. **Q1** Expand tests: orchestrator search/research (mocked fetchers), semaphore, `text.ts`, MCP/REST wiring, auth.
23. **Q4** eslint + prettier config + `lint` script.
24. **Q5** GitHub Actions CI (typecheck, lint, test, docker build).
25. **Q3/Q6/Q7/Q8** Type the HTTP layer; fix org naming/UA URL; `package.json` publish hygiene; config parse warnings.

---

## Validation strategy
- Every task must keep `npm run typecheck` and `npm test` green; add tests alongside code.
- After Phase A: run an external port scan from another host to confirm loopback-only default binding; confirm 401 timing is flat.
- After Phase B/C: load test with `k6` or `autocannon` against `/v1/research` to verify pool reuse, caching, and rate-limit behavior.
- Maintain the smoke test (`scripts/smoke-test.sh`) as the end-to-end gate.

## Out of scope
- Rewriting the MCP SDK integration or swapping Fastify.
- Replacing SearXNG/Camofox/CloakBrowser as backends.
- Multi-tenant authn/authz beyond the existing single shared bearer key.
