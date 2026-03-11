#!/usr/bin/env bash
# scripts/db/export-to-docker.sh
#
# Copies your local PostgreSQL data into the Docker dev volume
# (vision_postgres_data_dev) so it is available in docker:dev mode.
#
# Run once before first use, then again any time you want to re-sync.
#
# Prerequisites:
#   - Local postgres is running  (bun run db:start)
#   - Docker is running
#
# Usage:
#   bun run docker:import-data

set -euo pipefail

# ---- Config ------------------------------------------------------------------
LOCAL_PORT="${LOCAL_PG_PORT:-5433}"
LOCAL_USER="${LOCAL_PG_USER:-ftm_user}"
LOCAL_DB="${LOCAL_PG_DB:-financial_transactions}"
DOCKER_VOLUME="vision_postgres_data_dev"
DOCKER_DB_IMAGE="postgres:18-alpine"
DOCKER_USER="ftm_user"
DOCKER_DB="financial_transactions"
CONTAINER_NAME="vision_import_$$"

# postgres:18-alpine stores data at /var/lib/postgresql/18/docker (PGDATA default)
# The volume is mounted at /var/lib/postgresql so the container manages the subpath.
DOCKER_MOUNT="/var/lib/postgresql"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env"
if [ -f "$ENV_FILE" ]; then
  PG_PASS_LINE=$(grep -v '^#' "$ENV_FILE" | grep '^POSTGRES_PASSWORD=' || true)
  if [ -n "$PG_PASS_LINE" ]; then
    export "${PG_PASS_LINE?}"
  fi
fi
DOCKER_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

DUMP_FILE="/tmp/vision_export_$$.dump"

cleanup() {
  docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

# ---- Checks ------------------------------------------------------------------
echo "[1/5] Checking local PostgreSQL on port $LOCAL_PORT..."
if ! pg_isready -p "$LOCAL_PORT" -q 2>/dev/null; then
  echo "ERROR: Local PostgreSQL is not running on port $LOCAL_PORT."
  echo "Start it with:  bun run db:start"
  exit 1
fi

echo "[2/5] Checking Docker is running..."
if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ---- Dump --------------------------------------------------------------------
echo "[3/5] Dumping '$LOCAL_DB' from port $LOCAL_PORT..."
pg_dump \
  -p "$LOCAL_PORT" \
  -U "$LOCAL_USER" \
  --format=custom \
  --no-owner \
  --no-privileges \
  "$LOCAL_DB" \
  -f "$DUMP_FILE"
echo "      $(du -sh "$DUMP_FILE" | cut -f1) written."

# ---- Prepare volume ----------------------------------------------------------
echo "[4/5] Preparing Docker volume '$DOCKER_VOLUME'..."
docker volume rm "$DOCKER_VOLUME" > /dev/null 2>&1 || true
docker volume create "$DOCKER_VOLUME" > /dev/null

# Start postgres with volume mounted at /var/lib/postgresql so it initialises
# its data at the correct path (/var/lib/postgresql/18/docker) inside the volume.
docker run -d \
  --name "$CONTAINER_NAME" \
  -e "POSTGRES_USER=$DOCKER_USER" \
  -e "POSTGRES_DB=$DOCKER_DB" \
  -e "POSTGRES_PASSWORD=$DOCKER_PASSWORD" \
  -v "$DOCKER_VOLUME:$DOCKER_MOUNT" \
  "$DOCKER_DB_IMAGE" > /dev/null

echo "      Waiting for postgres to initialise..."
for i in $(seq 1 40); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$DOCKER_USER" -q 2>/dev/null; then
    echo "      Ready after ${i}s."
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "ERROR: Timed out waiting for postgres."
    exit 1
  fi
  sleep 1
done

# ---- Restore -----------------------------------------------------------------
echo "[5/5] Restoring dump into Docker volume..."
docker cp "$DUMP_FILE" "$CONTAINER_NAME:/tmp/restore.dump"

docker exec "$CONTAINER_NAME" \
  pg_restore \
    -U "$DOCKER_USER" \
    -d "$DOCKER_DB" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    /tmp/restore.dump

# Sanity check
ROW_COUNT=$(docker exec "$CONTAINER_NAME" \
  psql -U "$DOCKER_USER" -d "$DOCKER_DB" -tAc \
  "SELECT SUM(n_live_tup) FROM pg_stat_user_tables;" 2>/dev/null || echo "?")
echo "      Verified: ~${ROW_COUNT} rows in Docker volume."

echo ""
echo "Done. Your data is in Docker volume '$DOCKER_VOLUME'."
echo ""
echo "Start dev mode:     bun run docker:dev"
echo "Re-sync later:      bun run docker:import-data"
