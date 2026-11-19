#!/bin/bash
# BeModel 容器入口：初始化 PostgreSQL → 建库 → 建表 → 启动后端
set -e

PG_USER=${PG_USER:-bemodel}
PG_PASSWORD=${PG_PASSWORD:-bemodel}
PG_HOST=${PG_HOST:-127.0.0.1}
PG_PORT=${PG_PORT:-5432}
PG_PLATFORM_DB=${PG_PLATFORM_DB:-bemodel_platform}
PG_DATA=${PG_DATA:-/var/lib/postgresql/data}
# 自动探测 PostgreSQL 二进制目录（兼容不同 PG 主版本）
if [ -n "${PG_BIN:-}" ]; then
  : # 使用显式指定的路径
else
  PG_BIN=$(dirname "$(find /usr/lib/postgresql -name pg_ctl -type f 2>/dev/null | head -1)")
  PG_BIN=${PG_BIN:-/usr/lib/postgresql/15/bin}
fi

# ---------- 启动本地 PostgreSQL ----------
# PG 数据目录为空时初始化并启动；否则直接启动
if [ ! -s "$PG_DATA/PG_VERSION" ]; then
  echo "[BeModel] 初始化 PostgreSQL 数据目录：$PG_DATA"
  mkdir -p "$PG_DATA"
  chown -R postgres:postgres "$PG_DATA"
  su postgres -c "$PG_BIN/initdb -D $PG_DATA -U $PG_USER --auth-local=trust --auth-host=scram-sha-256"
  # 允许本地信任连接（容器内应用直连）
  echo "host all all 127.0.0.1/32 trust" >> "$PG_DATA/pg_hba.conf"
  echo "local all all trust" >> "$PG_DATA/pg_hba.conf"
fi

# 后台启动 PG
su postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -o '-c listen_addresses=127.0.0.1 -p $PG_PORT' -l /tmp/pg.log -w start"

# 设置超级用户密码（供应用经 127.0.0.1 scram 连接）
# 注意：必须走本地 socket（pg_hba 首条 local trust），走 -h 127.0.0.1 会命中 initdb 生成的
# scram-sha-256 规则而此时超级用户尚无密码，ALTER 会静默失败导致应用后续认证不过
su postgres -c "$PG_BIN/psql -U $PG_USER -d postgres -c \"ALTER USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\"" || echo "[BeModel] 警告：设置 PG 密码失败（应用可能无法连接）"

# 等待 PG 就绪
for i in $(seq 1 30); do
  if su postgres -c "$PG_BIN/pg_isready -h 127.0.0.1 -p $PG_PORT -U $PG_USER" >/dev/null 2>&1; then
    echo "[BeModel] PostgreSQL 已就绪"
    break
  fi
  sleep 1
done

# ---------- 应用密钥自举 ----------
# 生产环境强制 JWT_SECRET/APP_SECRET_KEY；魔搭空间不便逐个配环境变量，
# 首次启动生成随机密钥并持久化到 PG 数据卷（随卷存续，重启不变；重建镜像/清卷则换新）
SECRET_DIR="$PG_DATA/app-secrets"
mkdir -p "$SECRET_DIR"
chown -R postgres:postgres "$SECRET_DIR" 2>/dev/null || true
chmod 777 "$SECRET_DIR" 2>/dev/null || true
for KEY_NAME in JWT_SECRET APP_SECRET_KEY; do
  FILE="$SECRET_DIR/$KEY_NAME"
  if [ ! -s "$FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 40 > "$FILE"
    echo "[BeModel] 已生成 $KEY_NAME（持久化于 $FILE）"
  fi
  export "$KEY_NAME=$(cat "$FILE")"
done

# ---------- 建库（平台库 + 各业务库由后端 ensureDatabases 处理） ----------
# 后端启动时会自动 CREATE DATABASE 平台库与各业务库，这里无需手动建

# ---------- 本地向量化服务（OpenAI 兼容 /v1/embeddings） ----------
if [ -f /app/embed/server.mjs ]; then
  echo "[BeModel] 启动本地向量服务（bge-small-zh-v1.5）…"
  (cd /app/embed && nohup node server.mjs > /tmp/embed.log 2>&1 &)
  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:11435/health >/dev/null 2>&1; then
      echo "[BeModel] 向量服务已就绪"
      break
    fi
    sleep 1
  done
  export EMBEDDING_BASE_URL=${EMBEDDING_BASE_URL:-http://127.0.0.1:11435/v1}
  export EMBEDDING_MODEL=${EMBEDDING_MODEL:-bge-small-zh-v1.5}
  export EMBEDDING_TIMEOUT_MS=${EMBEDDING_TIMEOUT_MS:-20000}
fi

# ---------- 启动后端 ----------
echo "[BeModel] 启动后端服务…"
cd /app/server
exec node src/index.js
