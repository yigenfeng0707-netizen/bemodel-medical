# ===================== Stage 1: 构建前端 =====================
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ===================== Stage 2: 运行时（后端 + PostgreSQL 同镜像） =====================
FROM node:22-bookworm-slim AS runtime

# 安装 PostgreSQL（魔搭单容器自装 PG；阿里云可换外部 RDS 只换配置）
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ .

# 拷入前端构建产物（后端托管静态资源）
COPY --from=web-build /web/dist /app/web/dist

COPY server/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 运行时环境变量默认值（生产须用 compose / 平台注入覆盖）
ENV NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0 \
    PG_HOST=127.0.0.1 \
    PG_PORT=5432 \
    PG_USER=bemodel \
    PG_PASSWORD=bemodel \
    PG_PLATFORM_DB=bemodel_platform \
    WEB_DIST=/app/web/dist

EXPOSE 7860

ENTRYPOINT ["/app/entrypoint.sh"]
