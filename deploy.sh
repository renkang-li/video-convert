#!/usr/bin/env bash
set -euo pipefail

APP_NAME="video-convert"
IMAGE_NAME="video-convert:latest"
PORT="33219"
TMPFS_SIZE="6g"
MAX_UPLOAD_MB="2048"
CHUNK_UPLOAD_MB="16"
TMP_FILE_MAX_AGE_MIN="10"
HEALTH_URL="https://videoconvert.lrk666.eu.org/"
FORCE="false"

if [[ "${1:-}" == "--force" ]]; then
  FORCE="true"
fi

cd "$(dirname "$0")"

echo "==> Fetching latest code"
git pull --ff-only

echo "==> Checking active connections"
if ss -tnp | rg ":${PORT}\\b" >/tmp/${APP_NAME}-connections.txt; then
  cat /tmp/${APP_NAME}-connections.txt
  if [[ "$FORCE" != "true" ]]; then
    echo "Active connections found. Re-run with ./deploy.sh --force to deploy anyway."
    exit 1
  fi
fi

if docker ps --format '{{.Names}}' | rg "^${APP_NAME}$" >/dev/null; then
  echo "==> Current temp files"
  docker exec "$APP_NAME" sh -lc 'find /app/tmp -maxdepth 2 -print | sort' || true
fi

echo "==> Building image"
docker build -t "$IMAGE_NAME" .

if docker ps -a --format '{{.Names}}' | rg "^${APP_NAME}$" >/dev/null; then
  echo "==> Replacing container"
  docker stop "$APP_NAME"
  docker rm "$APP_NAME"
else
  echo "==> Starting new container"
fi

docker run -d --name "$APP_NAME" --restart unless-stopped \
  -p "127.0.0.1:${PORT}:${PORT}" \
  --tmpfs "/app/tmp:rw,noexec,nosuid,size=${TMPFS_SIZE}" \
  -e "MAX_UPLOAD_MB=${MAX_UPLOAD_MB}" \
  -e "CHUNK_UPLOAD_MB=${CHUNK_UPLOAD_MB}" \
  -e "TMP_FILE_MAX_AGE_MIN=${TMP_FILE_MAX_AGE_MIN}" \
  "$IMAGE_NAME"

echo "==> Container status"
docker ps --filter "name=${APP_NAME}" --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

echo "==> Health check"
for attempt in $(seq 1 10); do
  if curl -fsSI --max-time 20 "$HEALTH_URL" >/tmp/${APP_NAME}-health.txt; then
    sed -n '1,8p' /tmp/${APP_NAME}-health.txt
    break
  fi

  if [[ "$attempt" == "10" ]]; then
    cat /tmp/${APP_NAME}-health.txt 2>/dev/null || true
    echo "Health check failed after ${attempt} attempts."
    exit 1
  fi

  echo "Health check failed, retrying (${attempt}/10)..."
  sleep 2
done

echo "==> Recent logs"
docker logs --tail 30 "$APP_NAME"

echo "==> Deployed successfully"
