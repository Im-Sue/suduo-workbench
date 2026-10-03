# 基础镜像与依赖源可替换：国内服务器用 ./scripts/suduo-cloud.sh install --mirror cn，
# 或在 server/.env 里设置 SUDUO_NODE_IMAGE / SUDUO_NPM_REGISTRY（compose 会作为构建参数传进来）。
ARG NODE_IMAGE=node:24.10.0-bookworm-slim

FROM ${NODE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
# pnpm 依赖与 corepack 下载 pnpm 本体都走同一个源。
ENV npm_config_registry=${NPM_REGISTRY} \
  COREPACK_NPM_REGISTRY=${NPM_REGISTRY}

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/package.json contracts/package.json
COPY server/package.json server/package.json

RUN corepack enable && pnpm install --frozen-lockfile

COPY contracts/src contracts/src
COPY contracts/tsconfig.json contracts/tsconfig.json
COPY server/src server/src
COPY server/migrations server/migrations
COPY server/tsconfig.json server/tsconfig.json

RUN pnpm --filter @suduo/cloud-contracts run build \
  && pnpm --filter @suduo/cloud-server run build \
  && pnpm --filter @suduo/cloud-server --prod deploy --legacy /opt/requirements-service \
  && node -p "require('./package.json').version" > /opt/requirements-service/SUDUO_VERSION

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
# 房间文件根目录的镜像内缺省值（对应下面预建的目录与 compose 的具名卷）；.env 里设置的值优先。
ENV REQUIREMENTS_ROOM_FILE_ROOT=/var/lib/suduo/room-files
WORKDIR /app

RUN groupadd --system --gid 10001 suduo \
  && useradd --system --uid 10001 --gid suduo --home-dir /nonexistent --shell /usr/sbin/nologin suduo \
  && install --directory --owner=suduo --group=suduo --mode=0700 /var/lib/suduo/attachments \
  && install --directory --owner=suduo --group=suduo --mode=0700 /var/lib/suduo/room-files

COPY --from=build --chown=suduo:suduo /opt/requirements-service/ ./

USER suduo

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.REQUIREMENTS_PORT || '4100') + '/v2/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/main.js"]
