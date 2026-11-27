# ---- website: type-checked and built by Vite
FROM node:26.13.1-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npx tsc -b && npx vite build && node scripts/prerender.mjs && node scripts/precompress.mjs

# ---- backend: same Node version as development (TypeScript runs natively, node:sqlite built in)
FROM node:26.13.1-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY data/markets.json ./data/markets.json
COPY tsconfig.json ./
COPY --from=web /web/dist ./web/dist

# The database lives on a mounted volume (DB_PATH=/data/agent-utility.db on Railway).
# Railway provides PORT; the service must listen on every interface.
ENV HOST=0.0.0.0
CMD ["node", "src/main.ts"]
