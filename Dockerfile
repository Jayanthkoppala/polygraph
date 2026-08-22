# Polygraph hosted server image — tenant-architecture.md §6.
#
# better-sqlite3 is a native module: build it (and the frontend) in a
# full-toolchain stage, then copy only the built artefacts into a slim
# runtime image. Two separate npm trees (repo root + app/) are built here —
# the backend (dist/) and the React frontend (app/dist/) — because `serve`
# needs both: dist/index.js is the process entrypoint, app/dist/ is the SPA
# it serves as static assets (src/tenancy/http-routes.ts's serveStaticOrSpa,
# with a graceful "hasn't been built yet" degrade if app/dist ever went
# missing — it never does in this image).

FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Backend deps + build.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Frontend deps + build (Vite + React + TS + Tailwind v4, see app/package.json).
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci
COPY app ./app
RUN cd app && npm run build

# Prune backend devDependencies only AFTER both builds have run (tsc/vite
# themselves aren't needed at runtime, but were needed to produce dist/ and
# app/dist/ above).
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/app/dist ./app/dist
COPY package.json ./

# The volume mount point, owned by the unprivileged `node` user BEFORE the
# volume is mounted — otherwise Fly's volume mount creates it root-owned and
# `polygraph serve` can't write polygraph.sqlite. `polygraph serve` runs
# migrations on boot (src/tenancy/migrate.ts, via serve.ts's bootstrap) and
# refuses to start if the master-key canary does not decrypt
# (src/tenancy/crypto.ts's assertMasterKeyCanary — tenant-architecture.md §2
# "Master-key detection at boot").
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "serve", "--host", "0.0.0.0", "--port", "8080"]
