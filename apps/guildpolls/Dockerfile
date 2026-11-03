# No dependencies and no build step, so this builds in seconds on the small Hetzner edge box.
# Pinned to the node:22-alpine digest already on that box (shared with its other Node services), so a
# rebuild never pulls a different base. node:sqlite needs Node 22.13 or later.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
WORKDIR /app
# release.json (the commit /api/health reports) exists only in CI-built releases.
COPY package.json release.json* ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --start-interval=2s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
