#!/usr/bin/env bash
set -Eeuo pipefail

SSH_HOST="${SSH_HOST:-rainyun}"
REMOTE_DIR="${REMOTE_DIR:-/root/xgoatcast}"
SERVICE="${SERVICE:-xgoatcast}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_NAME="xgoatcast-deploy-$$.tar.gz"
LOCAL_ARCHIVE="${TMPDIR:-/tmp}/${ARCHIVE_NAME}"

cleanup() {
  rm -f -- "$LOCAL_ARCHIVE"
}
trap cleanup EXIT

cd "$PROJECT_DIR"

echo "[0/5] 即将部署: $(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')"
echo "[1/5] 本地构建前端和后端 dist"
npm run build

echo "[2/5] 打包运行所需文件"
tar -czf "$LOCAL_ARCHIVE" \
  Dockerfile \
  docker-compose.yml \
  package.json \
  package-lock.json \
  server/package.json \
  web/package.json \
  server/dist \
  web/dist

echo "[3/5] 上传到 ${SSH_HOST}:${REMOTE_DIR}"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
scp "$LOCAL_ARCHIVE" "${SSH_HOST}:${REMOTE_DIR}/${ARCHIVE_NAME}"

echo "[4/5] 替换 dist，删除旧容器和旧镜像，重新部署"
ssh "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$ARCHIVE_NAME" "$SERVICE" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

REMOTE_DIR="$1"
ARCHIVE_NAME="$2"
SERVICE="$3"
STAGE_DIR="${REMOTE_DIR}/.deploy-stage-$$"

cleanup_remote() {
  rm -rf -- "$STAGE_DIR"
  rm -f -- "${REMOTE_DIR}/${ARCHIVE_NAME}"
}
trap cleanup_remote EXIT

cd "$REMOTE_DIR"

if [[ ! -f .env ]]; then
  echo "错误：远端 ${REMOTE_DIR}/.env 不存在，停止部署。" >&2
  exit 1
fi

mkdir -p "$STAGE_DIR"
tar -xzf "${REMOTE_DIR}/${ARCHIVE_NAME}" -C "$STAGE_DIR"

test -f "${STAGE_DIR}/server/dist/main.js"
test -f "${STAGE_DIR}/web/dist/index.html"

# 仅替换部署内容；保留 .env、Docker volumes 和其他服务器文件。
rm -rf -- "${REMOTE_DIR}/server/dist" "${REMOTE_DIR}/web/dist"
mkdir -p "${REMOTE_DIR}/server" "${REMOTE_DIR}/web"
mv "${STAGE_DIR}/server/dist" "${REMOTE_DIR}/server/dist"
mv "${STAGE_DIR}/web/dist" "${REMOTE_DIR}/web/dist"

for file in Dockerfile docker-compose.yml package.json package-lock.json; do
  mv -f -- "${STAGE_DIR}/${file}" "${REMOTE_DIR}/${file}"
done
mv -f -- "${STAGE_DIR}/server/package.json" "${REMOTE_DIR}/server/package.json"
mv -f -- "${STAGE_DIR}/web/package.json" "${REMOTE_DIR}/web/package.json"

docker compose config --quiet

# 先记录 Compose 当前使用的镜像，再删除容器和镜像。不会删除 volume。
mapfile -t OLD_IMAGE_IDS < <(docker compose images -q | sort -u)
docker compose down --remove-orphans

for image_id in "${OLD_IMAGE_IDS[@]}"; do
  docker image rm "$image_id" || true
done

	docker compose build --pull
	docker image prune -f
	docker compose up -d
REMOTE_SCRIPT

echo "[5/5] 等待服务健康"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  container_id="$(
    ssh "$SSH_HOST" \
      "cd '$REMOTE_DIR' && docker compose ps -q '$SERVICE'" |
      tr -d '\r'
  )"

  if [[ -n "$container_id" ]]; then
    health="$(
      ssh "$SSH_HOST" \
        "docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' '$container_id'" |
        tr -d '\r'
    )"

    if [[ "$health" == "healthy" ]]; then
      ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose ps"
      echo "部署完成：${SERVICE} 已通过健康检查。"
      exit 0
    fi

    if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
      break
    fi

    echo "当前状态：${health}"
  else
    echo "等待容器创建..."
  fi

  sleep 3
done

echo "部署未在 ${HEALTH_TIMEOUT} 秒内变为 healthy，最近日志如下：" >&2
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose ps -a && docker compose logs --tail=100 '$SERVICE'" >&2
exit 1
