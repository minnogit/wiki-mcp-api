# Immagine del server MCP HTTP (sola lettura). Il contenuto della wiki NON sta
# nell'immagine: si monta da fuori (vedi deploy/docker-compose.example.yml).
#
#   docker build -t wiki-mcp-api .                     # server HTTP
#   docker build --target sync -t wiki-mcp-sync .      # sidecar di sincronizzazione git

# --- build: dipendenze complete e compilazione TypeScript -> dist/ -----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- deps: solo dipendenze di produzione ---------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- sync: sidecar che tiene aggiornato il checkout della wiki -----------------
FROM node:24-slim AS sync
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
WORKDIR /opt/wiki-mcp-api
COPY deploy/sync-wiki.sh deploy/sync-loop.sh ./deploy/
ENV WIKI_CHECKOUT=/data/checkout
USER node
CMD ["/opt/wiki-mcp-api/deploy/sync-loop.sh"]

# --- runtime: ultimo stage, quello costruito di default ------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000 \
    WIKI_PATH=/data/checkout/wiki \
    RAW_PATH=/data/checkout/raw
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/http.js"]
