# Implementation notes

## Deterministic escalation

`web_fetch` owns the backend chain and stops as soon as it reaches a terminal outcome:

1. direct HTTP with DNS pinning and safe redirect validation
2. optional Crawl4AI Markdown extraction through the filtering egress proxy
3. Camofox through the filtering egress proxy
4. CloakBrowser through the same filtering egress proxy, with per-request route validation as defense in depth

The model does not decide whether a failed request should escalate. Responses include every attempted backend and its classified outcome. `web_research` asks auto fetches to prefer Crawl4AI because query-aware Markdown is usually better context for agents; if Crawl4AI fails, a successful direct response remains a safe fallback.

## Terminal outcomes

The service does not try another backend for:

- authentication or subscription requirements
- unresolved human verification
- explicit policy denial
- private/internal destinations
- not found responses
- unsupported content types

## Crawl4AI isolation

Crawl4AI runs as a private sidecar behind the Node orchestrator. The MCP and REST schemas expose only bounded inputs: URL, optional relevance query, maximum characters, link inclusion, and backend selection. They do not expose arbitrary JavaScript, cookies, browser profile paths, proxy settings, LLM extraction instructions, or domain mapping.

The sidecar is connected only to `crawl4ai-control`. Its browser traffic uses `CRAWL4AI_PROXY=http://egress-proxy:3128`, so redirects and subresources are still filtered by the DNS-pinning egress proxy. The orchestrator validates the initial URL before calling the sidecar and revalidates the returned final URL before accepting sidecar content.

## Camofox isolation

Camofox is connected only to the internal `camofox-control` network. It has no direct Docker network with internet routing. Its configured HTTP proxy is `egress-proxy:3128`, which validates and DNS-pins every ordinary HTTP request and HTTPS `CONNECT` destination.

The Camofox image fetches the Camoufox browser via a dedicated `camoufox-js fetch` build step into camoufox-js' default per-user cache and validates the executable through `camoufox-js`' own resolver. The server resolves the browser from the same cache at runtime. Because the newest `daijro/camoufox` release (`v152.0.2-alpha`, a GitHub prerelease) ships a fonts-only archive with no browser binary, the image patches `camoufox-js` to skip prereleases when selecting the asset, so `fetch` installs the latest usable non-prerelease (`v150.0.2-beta.25`). Revisit once `camoufox-js` filters prereleases upstream or a usable stable asset is republished.

The orchestrator and Camofox still share a control network so the orchestrator can call the Camofox REST API. Set `BROWSER_SEARCH_API_KEY` so browser-originated traffic cannot invoke the orchestrator's MCP or REST tools without the bearer secret.

## CloakBrowser isolation

CloakBrowser defaults to `http://egress-proxy:3128`. This preserves the host's normal residential WAN egress while preventing a second browser DNS lookup from bypassing the URL validator through DNS rebinding. Set `CLOAK_GEOIP=false` for this local filtering proxy and configure timezone/locale explicitly.

## Remaining trust assumptions

This is a defensive local research service, not a hardened multi-tenant browser sandbox. Browser engines and Crawl4AI parse hostile web content, so keep the containers patched, do not mount sensitive host directories, and do not expose their internal ports to untrusted networks.
