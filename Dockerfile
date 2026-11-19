FROM node:22-bookworm-slim

# 国内构建机加速：Debian 源切阿里云
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi

# 单镜像内含 PostgreSQL（随容器启动自举）+ curl（向量服务健康检查/模型下载）
# ca-certificates 显式安装：--no-install-recommends 不会带 CA 包，curl 会报 exit 77
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib curl ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com
COPY server/ .

# 前端为本地预构建产物（避免构建机跑 vite）
COPY web/dist /app/web/dist

# ---------- 本地向量化服务（bge-small-zh-v1.5 ONNX 量化，512 维） ----------
WORKDIR /app/embed
COPY embed/package.json ./
# 构建机无法访问 CUDA 下载源：跳过 onnxruntime-node 的 CUDA EP 安装（CPU 推理足够）
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --omit=dev --registry=https://registry.npmmirror.com --onnxruntime-node-install-cuda=skip
COPY embed/server.mjs ./
RUN mkdir -p /app/embed/model/bge-small-zh-v1.5/onnx \
  && cd /app/embed/model/bge-small-zh-v1.5 \
  && dl() { curl -fsSL --retry 3 "$1" -o "$2" || curl -fsSLk --retry 3 "$1" -o "$2"; } \
  && for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do \
       dl "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/$f" "$f"; \
     done \
  && dl "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx" onnx/model_quantized.onnx \
  && ls -lh . onnx

COPY server/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0 \
    PG_HOST=127.0.0.1 \
    PG_PORT=5432 \
    PG_USER=bemodel \
    PG_PASSWORD=bemodel \
    PG_PLATFORM_DB=bemodel_platform \
    WEB_DIST=/app/web/dist \
    EMBEDDING_BASE_URL=http://127.0.0.1:11435/v1 \
    EMBEDDING_MODEL=bge-small-zh-v1.5 \
    EMBEDDING_TIMEOUT_MS=20000

EXPOSE 7860

ENTRYPOINT ["/app/entrypoint.sh"]
