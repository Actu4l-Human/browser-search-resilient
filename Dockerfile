FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl dumb-init \
    fonts-liberation fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnss3 libpango-1.0-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
    libxrandr2 xdg-utils xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 browser && useradd --uid 10001 --gid browser --create-home browser
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /home/browser/.cloakbrowser /data/profiles && chown -R browser:browser /home/browser /data/profiles /app

USER browser
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8088 CLOAKBROWSER_CACHE_DIR=/home/browser/.cloakbrowser
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8088/healthz || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/http.js"]
