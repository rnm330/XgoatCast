# Runtime image assembled on the server from locally built dist artifacts.
# Application source and frontend toolchains are intentionally not built here.
FROM node:20.18-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install only server runtime dependencies. better-sqlite3 is a native addon,
# so its build toolchain is installed temporarily and removed afterwards.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev --workspace server --include-workspace-root=false \
      --no-audit --no-fund && \
    npm rebuild better-sqlite3 --workspace server && \
    npm cache clean --force && \
    apk del .build-deps

COPY server/dist server/dist
COPY web/dist web/dist

RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3520

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3520/ || exit 1

CMD ["node", "server/dist/main.js"]
