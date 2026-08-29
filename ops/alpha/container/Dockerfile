FROM rust:1.94.1-bookworm AS native
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY spikes spikes
COPY tools/load tools/load
COPY tools/m7-acceptance tools/m7-acceptance
COPY tools/reference-model tools/reference-model
COPY tools/region-import/germany/operational-infrastructure-v2-direct-contract-launcher.windows.ps1 tools/region-import/germany/operational-infrastructure-v2-direct-contract-launcher.windows.ps1
RUN cargo build --release --locked -p zugfolge-runtime-napi --features node-addon -p zugfolge-planning-runtime-napi --features node-addon
RUN cargo build --release --locked -p zugfolge-infra --bin zugfolge-infra-release

FROM node:24.13.0-bookworm-slim AS nodebuild
RUN corepack enable
WORKDIR /app
ARG LIVEMAP_BASE_PATH=/
ARG OPERATIONS_CENTER_BASE_PATH=/
ARG OPERATIONS_CENTER_GAME_API_URL=
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tools tools
COPY docs/glossar.md docs/glossar.md
RUN pnpm install --frozen-lockfile && pnpm build
RUN cd apps/livemap \
  && pnpm exec vite build --base="${LIVEMAP_BASE_PATH}" \
  && node scripts/copy-maplibre-workers.mjs
RUN cd apps/operations-center \
  && pnpm exec vite build --base="${OPERATIONS_CENTER_BASE_PATH}" \
  && GAME_API_URL="${OPERATIONS_CENTER_GAME_API_URL}" node -e 'const fs=require("node:fs");const path="dist/index.html";const source=fs.readFileSync(path,"utf8");const marker="<meta name=\"game-api-url\" content=\"\">";if(!source.includes(marker))throw new Error("Operations-Center API-Meta fehlt");fs.writeFileSync(path,source.replace(marker,`<meta name="game-api-url" content="${process.env.GAME_API_URL}">`));'

FROM node:24.13.0-bookworm-slim
ARG ZUGFOLGE_SOURCE_SHA
ARG ZUGFOLGE_DEPLOY_PATCH_SHA
LABEL org.opencontainers.image.source="https://github.com/larynxberlin-rgb/Zugfolge" \
  org.opencontainers.image.revision="${ZUGFOLGE_SOURCE_SHA}" \
  de.zugfolge.deploy-patch="${ZUGFOLGE_DEPLOY_PATCH_SHA}"
RUN printf '%s\n' "${ZUGFOLGE_SOURCE_SHA}" | grep -Eq '^[0-9a-f]{40}$' \
  && test "${ZUGFOLGE_DEPLOY_PATCH_SHA}" = "none"
WORKDIR /app
ENV NODE_ENV=production \
  INFRA_OPERATIONAL_V2_VALIDATOR_PATH=/app/native/zugfolge-infra-release
COPY --from=nodebuild /app /app
COPY --from=native /src/target/release/libzugfolge_runtime_napi.so /app/native/zugfolge-runtime.node
COPY --from=native /src/target/release/libzugfolge_planning_runtime_napi.so /app/native/zugfolge-planning-runtime.node
COPY --from=native /src/target/release/zugfolge-infra-release /app/native/zugfolge-infra-release
USER node
CMD ["node", "apps/game-api/dist/server.js"]
