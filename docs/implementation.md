# Implementation notes

## Deterministic escalation

`web_fetch` owns the backend chain and stops as soon as it reaches a terminal outcome:

1. direct HTTP with DNS pinning and safe redirect validation
2. Camofox through the filtering egress proxy
3. CloakBrowser through the same filtering egress proxy, with per-request route validation as defense in depth

The model does not decide whether a failed request should escalate. Responses include every attempted backend and its classified outcome.

## Terminal outcomes

The service does not try another backend for:

- authentication or subscription requirements
- unresolved human verification
- explicit policy denial
- private/internal destinations
- not found responses
- unsupported content types

## Camofox isolation

Camofox is connected only to the internal `camofox-control` network. It has no direct Docker network with internet routing. Its configured HTTP proxy is `egress-proxy:3128`, which validates and DNS-pins every ordinary HTTP request and HTTPS `CONNECT` destination.

The orchestrator and Camofox still share a control network so the orchestrator can call the Camofox REST API. Set `BROWSER_SEARCH_API_KEY` so browser-originated traffic cannot invoke the orchestrator's MCP or REST tools without the bearer secret.

## CloakBrowser isolation

CloakBrowser defaults to `http://egress-proxy:3128`. This preserves the host's normal residential WAN egress while preventing a second browser DNS lookup from bypassing the URL validator through DNS rebinding. Set `CLOAK_GEOIP=false` for this local filtering proxy and configure timezone/locale explicitly.

## Remaining trust assumptions

This is a defensive local research service, not a hardened multi-tenant browser sandbox. Browser engines parse hostile web content, so keep the containers patched, do not mount sensitive host directories, and do not expose their internal ports to untrusted networks.
