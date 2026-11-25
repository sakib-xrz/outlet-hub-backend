# syntax=docker/dockerfile:1.7
FROM node:24.22.3-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@12.23.0 \
  && npm cache clean --force
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm prisma:generate && pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm rebuild argon2

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY src/config/load-env.ts ./src/config/load-env.ts
COPY prisma ./prisma
USER node
ENTRYPOINT ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM node:24.22.3-bookworm-slim AS production
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 nodeapp && useradd --system --uid 10001 --gid nodeapp --home-dir /nonexistent --shell /usr/sbin/nologin nodeapp
COPY --from=production-dependencies --chown=nodeapp:nodeapp /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodeapp /app/dist ./dist
COPY --chown=nodeapp:nodeapp package.json ./
USER nodeapp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
