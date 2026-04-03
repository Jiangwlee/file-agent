FROM node:22-slim AS base

# Install build dependencies for native modules (better-sqlite3)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Build stage
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci
COPY tsconfig.json ./
COPY packages/ packages/
RUN npm run build --workspace=packages/frontend
RUN npm run build --workspace=packages/backend

# Production stage
FROM base AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --omit=dev
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/frontend/dist packages/frontend/dist

EXPOSE 8080
CMD ["node", "packages/backend/dist/index.js"]
