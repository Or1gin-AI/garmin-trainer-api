FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:20-alpine AS production

WORKDIR /app

# tini: clean signal handling for the worker which spawns child processes
RUN apk add --no-cache tini && rm -rf /var/cache/apk/*

RUN corepack enable

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile=false

COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

# Garmin sync uses the filesystem for activity downloads + MFA scratch space
RUN mkdir -p /app/data/temp /app/data/mfa
ENV DATA_DIR=/app/data

EXPOSE 4001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
