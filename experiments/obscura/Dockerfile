FROM node:26-bookworm-slim AS fetch
ARG OBSCURA_VERSION=0.2.2
ARG OBSCURA_URL=https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.2/obscura-x86_64-linux-stealth.tar.gz
ARG OBSCURA_SHA256=faf46c28948c10c6d44d6f46faad577adba43d63bb19b83cdb92a5e22bdd5da1
ARG OBSCURA_LICENSE_URL=https://raw.githubusercontent.com/h4ckf0r0day/obscura/v0.2.2/LICENSE
WORKDIR /work
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    mkdir -p /out /extract /out/licenses; \
    curl -fsSLo /tmp/obscura.tar.gz "$OBSCURA_URL"; \
    echo "$OBSCURA_SHA256  /tmp/obscura.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/obscura.tar.gz -C /extract; \
    obscura_bin="$(find /extract -type f -name obscura -print -quit)"; \
    obscura_worker_bin="$(find /extract -type f -name obscura-worker -print -quit)"; \
    test -n "$obscura_bin"; \
    test -n "$obscura_worker_bin"; \
    install -Dm0755 "$obscura_bin" /out/obscura; \
    install -Dm0755 "$obscura_worker_bin" /out/obscura-worker; \
    license_path="$(find /extract -type f \( -iname 'LICENSE' -o -iname 'LICENSE.*' -o -iname 'COPYING' \) -print -quit)"; \
    if [ -n "$license_path" ]; then \
      install -Dm0644 "$license_path" /out/licenses/obscura-LICENSE; \
    else \
      curl -fsSLo /out/licenses/obscura-LICENSE "$OBSCURA_LICENSE_URL"; \
    fi; \
    test -s /out/licenses/obscura-LICENSE; \
    chmod 0755 /out/obscura /out/obscura-worker

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="Obscura worker"
LABEL org.opencontainers.image.description="Pinned Obscura browser worker for the obscura experiment overlay"
WORKDIR /tmp
ENV HOME=/tmp
USER 65532:65532
COPY --from=fetch /out/obscura /obscura
COPY --from=fetch /out/obscura-worker /obscura-worker
COPY --from=fetch /out/licenses/obscura-LICENSE /usr/share/doc/obscura/LICENSE
ENTRYPOINT ["/obscura"]
CMD ["--proxy", "http://egress-proxy:3128", "--stealth", "serve", "--host", "0.0.0.0", "--port", "9222", "--workers", "1"]
