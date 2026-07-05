# Changelog

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
