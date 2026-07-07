# Changelog

## 0.2.2

### Fixed

- Work around an upstream `daijro/camoufox` packaging regression: the newest release (`v152.0.2-alpha`, a GitHub prerelease) ships a fonts-only `lin.x86_64.zip` with no browser binary, so `camoufox-js fetch` "succeeded" but produced an unusable install. Patch `camoufox-js@0.11.1` to skip prereleases when selecting the browser asset, so `fetch` installs the latest usable non-prerelease (`v150.0.2-beta.25`).
- Fetch the Camoufox browser in the Camofox Docker image via a dedicated `camoufox-js fetch` layer (`CAMOFOX_SKIP_DOWNLOAD=1` skips the `@askjo/camofox-browser` postinstall during `npm ci`) into camoufox-js' default per-user cache.
- Validate the installed Camoufox browser through `camoufox-js`' own resolver before continuing the image build.
- Override `swagger-jsdoc`'s deprecated `glob@11.1.0` transitive dependency in the Camofox runtime lockfile so clean installs use the current `glob@13` line.

### Security

- Crawl4AI sidecar `/extract` now fails closed (returns 401) when `CRAWL4AI_TOKEN` is unset, instead of allowing unauthenticated access to an SSRF-capable endpoint.
- Compare the Crawl4AI bearer token with `hmac.compare_digest` instead of `!=`, removing a timing side channel on the `/extract` auth check.
- Pin the Crawl4AI sidecar base image by immutable digest (`unclecode/crawl4ai:0.9.0@sha256:385042…`) so a tag re-push cannot alter the image.
- Pin the Camoufox browser binary in the Camofox Docker image: `camoufox-js fetch` has no version flag (it selects the latest non-prerelease), so the image now asserts the resolved browser version equals a pinned `CAMOUFOX_BROWSER_VERSION` (`150.0.2-alpha.26`, release tag `v150.0.2-beta.25`) and fails the build on drift, preventing an upstream release from silently swapping the binary.

### Changed

- Pin the Crawl4AI sidecar base image to `unclecode/crawl4ai:0.9.0` by digest (was `:latest`) and bound `fastapi`/`uvicorn[standard]` versions for reproducible installs.
- Pool a single long-lived browser in the Crawl4AI sidecar instead of launching Chromium on every `/extract` request.
- The Crawl4AI sidecar `/healthz` now probes the pooled browser's live connection (`browser_manager.browser.is_connected()`) and returns 503 when it is gone, so a post-startup browser crash flips the container unhealthy and triggers a self-healing restart.
- Return a single selected Markdown variant from the Crawl4AI sidecar (dropped the redundant `raw_markdown`/`fit_markdown` fields); the client consumes only `markdown`.
- Drop the unused `content_filter` field from the Crawl4AI client payload type.
- The orchestrator no longer blocks startup on the optional Crawl4AI sidecar's health (`depends_on` changed to `service_started`); `compose.dokploy.yaml` is aligned to the same `service_started` condition so both compose files agree.
- Centralize link handling in a shared `dedupeLinks`/`normalizeLinkHref` helper (`src/util/text.ts`) used by both the direct (HTML) and Crawl4AI (JSON) backends, replacing two parallel normalize+dedupe implementations; Crawl4AI link URLs are now URL-normalized for consistent deduplication.

### Fixed

- De-duplicate links during HTML collection (via the shared `LinkCollector`) instead of after collecting all anchors, restoring the prior behavior where the link cap counts unique URLs and anchor text is only extracted for first-seen links.

## 0.2.1

### Added

- Add an optional private Crawl4AI sidecar for LLM-ready Markdown extraction.
- Add `crawl4ai` as an explicit `web_fetch` backend and as a query-aware preferred extraction path for `web_research`.
- Add Compose and Dokploy wiring that keeps Crawl4AI on an internal control network and forces browser traffic through the DNS-pinning egress proxy.

### Security

- Keep URL admission and final-URL revalidation in the Node orchestrator before accepting Crawl4AI output.
- Do not expose arbitrary JavaScript, browser profiles, cookies, proxy configuration, LLM extraction, or domain mapping through the MCP schema.

## 0.2.0

### Security

- Block canonical IPv4-compatible, IPv4-mapped, translated, and NAT64 IPv6 representations when their embedded IPv4 destination is private or otherwise denied.
- Route CloakBrowser through the DNS-pinning egress proxy by default while retaining request interception as defense in depth.
- Add safe source packaging and CI checks that prevent `.env`, dependency trees, build output, and Git metadata from entering release archives.
- Add a security policy covering credential rotation and diagnostic archive handling.

### Reliability

- Replace the SearXNG readiness search with a local service check and require the egress proxy for readiness.
- Start Xvfb consistently for headed CloakBrowser operation in both local and Dokploy deployments.
- Correct graceful shutdown ordering and rejected-promise cleanup in the in-flight registry.
- Remove the persistent Camofox binary-cache volume so image upgrades cannot retain an older browser binary.
- Lock the complete Camofox npm dependency tree used by the compatibility patches.

### Correctness

- Implement longest-match robots.txt precedence, equal-length Allow precedence, and merging of equally specific user-agent groups.
- Preserve include/exclude domain and supported category constraints in browser-based search fallback.
- Upgrade `unpdf` to 1.6.2 and pass PDF input as a `Uint8Array`.

### Observability and delivery

- Record MCP tool invocations, backend durations, cache events, semaphore waits, and rate-limit rejections.
- Expand CI to build all images, validate both Compose manifests, audit both npm lockfiles, verify packaging, and reject tracked secret files.
- Add Dependabot coverage for the application, Camofox runtime lockfile, Dockerfiles, and GitHub Actions.
