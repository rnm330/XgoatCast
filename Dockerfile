# ===== Stage 1: Build =====
FROM node:20.18-alpine AS build
WORKDIR /app
ENV NODE_ENV=development

# Install build dependencies for better-sqlite3 (native addon)
RUN apk add --no-cache python3 make g++

# Copy workspace config and install all dependencies
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --no-audit --no-fund && \
    npm cache clean --force

# Rebuild better-sqlite3 against Alpine's libraries
RUN cd server && npx npm rebuild better-sqlite3

# Copy source code
COPY server/tsconfig.json server/tsconfig.build.json server/nest-cli.json server/
COPY server/src/ server/src/
COPY web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json web/vite.config.ts web/
COPY web/tailwind.config.js web/postcss.config.js web/
COPY web/index.html web/
COPY web/public/ web/public/
COPY web/src/ web/src/

# Build
RUN npm run build:web && npm run build:server

# ===== Stage 2: Production =====
FROM node:20.18-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install server runtime dependencies only
WORKDIR /app/server
COPY server/package.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm rebuild better-sqlite3 && \
    npm cache clean --force

# Copy built artifacts from build stage
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist ../web/dist

WORKDIR /app
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3520

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3520/ || exit 1

CMD ["node", "server/dist/main.js"]
