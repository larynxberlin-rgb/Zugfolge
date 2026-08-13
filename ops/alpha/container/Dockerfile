FROM rust:1.94.1-bookworm AS native
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY spikes spikes
COPY tools/load tools/load
COPY tools/m7-acceptance tools/m7-acceptance
COPY tools/reference-model tools/reference-model
RUN cargo build --release --locked -p zugfolge-runtime-napi --features node-addon -p zugfolge-planning-runtime-napi --features node-addon

FROM node:24.13.0-bookworm-slim AS nodebuild
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tools tools
COPY docs/glossar.md docs/glossar.md
RUN pnpm install --frozen-lockfile && pnpm build
RUN cd apps/livemap \
  && pnpm exec vite build --base=/live/ \
  && node scripts/copy-maplibre-workers.mjs \
  && node -e 'const fs=require("node:fs");const path="dist/index.html";const source=fs.readFileSync(path,"utf8");const output=source.replace("src=\"/runtime-config.js\"","src=\"/live/runtime-config.js\"");if(output===source)throw new Error("Livemap Runtime-Konfiguration fehlt");fs.writeFileSync(path,output);'
RUN cd apps/operations-center \
  && pnpm exec vite build --base=/ops/ \
  && node -e 'const fs=require("node:fs");const path="dist/index.html";const source=fs.readFileSync(path,"utf8");const output=source.replace("<meta name=\"game-api-url\" content=\"\">","<meta name=\"game-api-url\" content=\"/api\">");if(output===source)throw new Error("Operations-Center API-Meta fehlt");fs.writeFileSync(path,output);'

FROM node:24.13.0-bookworm-slim
ARG ZUGFOLGE_SOURCE_SHA
ARG ZUGFOLGE_DEPLOY_PATCH_SHA
LABEL org.opencontainers.image.source="https://github.com/larynxberlin-rgb/Zugfolge" \
  org.opencontainers.image.revision="${ZUGFOLGE_SOURCE_SHA}" \
  de.zugfolge.deploy-patch="${ZUGFOLGE_DEPLOY_PATCH_SHA}"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=nodebuild /app /app
COPY --from=native /src/target/release/libzugfolge_runtime_napi.so /app/native/zugfolge-runtime.node
COPY --from=native /src/target/release/libzugfolge_planning_runtime_napi.so /app/native/zugfolge-planning-runtime.node
USER node
CMD ["node", "apps/game-api/dist/server.js"]
