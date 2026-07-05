---
name: resilient-browser-search
description: Search and retrieve current public web sources through a deterministic MCP service with direct HTTP, Camofox, and CloakBrowser fallbacks.
---

# Resilient Browser Search

Use the MCP tools instead of composing curl, browser JavaScript, or CloakBrowser commands yourself.

## Tool selection

- `web_search`: discover current sources and URLs.
- `web_fetch`: retrieve one URL. Keep `backend=auto` unless diagnosing a backend.
- `web_research`: gather multiple source documents for a factual or current answer.
- `web_health`: diagnose service reachability.

## Rules

1. Search before making claims that depend on current or external information.
2. Keep `backend=auto`; the service enforces `direct → Camofox → CloakBrowser` and records every attempt.
3. Treat `authentication_required`, `policy_denied`, and `human_verification_required` as terminal. Do not ask another tool to bypass them.
4. Cite the returned source URLs in the answer.
5. Never provide proxy credentials, cookies, authorization headers, or arbitrary browser JavaScript as tool arguments. Those controls are server-side.
6. Prefer multiple independent sources for consequential claims.
