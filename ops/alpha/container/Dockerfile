FROM rust:1.94.1-bookworm AS native
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release --locked -p zugfolge-runtime-napi --features node-addon -p zugfolge-planning-runtime-napi --features node-addon

FROM node:24.13.0-bookworm-slim AS nodebuild
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tools tools
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24.13.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=nodebuild /app /app
COPY --from=native /src/target/release/libzugfolge_runtime_napi.so /app/native/zugfolge-runtime.node
COPY --from=native /src/target/release/libzugfolge_planning_runtime_napi.so /app/native/zugfolge-planning-runtime.node
USER node
CMD ["node", "apps/game-api/dist/server.js"]
