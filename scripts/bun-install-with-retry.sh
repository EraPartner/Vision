#!/bin/sh

set -eu

max_attempts=3
attempt=1

while ! bun install "$@"; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "[bun-install] Failed after $max_attempts attempts." >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  echo "[bun-install] Transient install failure; retrying ($attempt/$max_attempts)..." >&2
  sleep 2
done
