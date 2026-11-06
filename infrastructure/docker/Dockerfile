FROM node:24.15.0-bookworm-slim AS base
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/commerce/package.json apps/commerce/package.json
COPY apps/billing/package.json apps/billing/package.json
COPY apps/bank-simulator/package.json apps/bank-simulator/package.json
COPY packages/runtime/package.json packages/runtime/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY tsconfig.json .prettierrc.json .prettierignore compose.yaml compose.dev.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY infrastructure ./infrastructure
RUN npm run build
CMD ["npm", "test"]

FROM mcr.microsoft.com/playwright:v1.65.0-noble AS ui-verification
WORKDIR /workspace
COPY --from=development /usr/local/bin/node /usr/local/bin/node
COPY --from=development /workspace /workspace
ENV NODE_OPTIONS=--max-old-space-size=768
CMD ["node", "scripts/ui-smoke.mjs"]

FROM development AS build
RUN npm run validate:schemas && npm prune --omit=dev --ignore-scripts

FROM base AS production
ARG SERVICE_NAME
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/dist/packages ./dist/packages
COPY --from=build --chown=node:node /workspace/dist/apps/${SERVICE_NAME} ./dist/apps/${SERVICE_NAME}
COPY --chown=node:node scripts/container-entrypoint.mjs scripts/container-healthcheck.mjs ./scripts/
ENV SERVICE_NAME=${SERVICE_NAME}
USER node
EXPOSE 3000
CMD ["node", "scripts/container-entrypoint.mjs"]
