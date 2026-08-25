#!/usr/bin/env bash

# Shared helpers for the Codex cloud lifecycle scripts. Callers enable strict
# mode themselves so this file can also be sourced by focused shell tests.

cloud_log() {
  printf '[vision-cloud] %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cloud_package_env() {
  local name
  local -a clean_env=(
    env -i
    "HOME=$HOME"
    "PATH=$PATH"
    "CODEX_SESSION_ENV=${CODEX_SESSION_ENV:-cloud}"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
  )
  for name in \
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
    http_proxy https_proxy all_proxy no_proxy \
    SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS \
    REQUESTS_CA_BUNDLE CURL_CA_BUNDLE; do
    if printenv "$name" >/dev/null 2>&1; then
      clean_env+=("$name=${!name}")
    fi
  done
  "${clean_env[@]}" "$@"
}

cloud_run_package_with_timeout() {
  local duration="$1"
  shift

  if [[ "${VISION_CLOUD_DISABLE_TIMEOUT:-0}" == 1 ]]; then
    cloud_package_env "$@"
    return
  fi

  if command -v timeout >/dev/null 2>&1; then
    cloud_package_env timeout --kill-after=10s "$duration" "$@"
    return
  fi

  cloud_log "WARNING: timeout(1) is unavailable; running package command without an external deadline: $1" >&2
  cloud_package_env "$@"
}

cloud_run_with_timeout() {
  local duration="$1"
  shift

  if [[ "${VISION_CLOUD_DISABLE_TIMEOUT:-0}" == 1 ]]; then
    "$@"
    return
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=10s "$duration" "$@"
    return
  fi

  cloud_log "WARNING: timeout(1) is unavailable; running without an external deadline: $1" >&2
  "$@"
}

cloud_run_with_foreground_timeout() {
  local duration="$1"
  shift

  if [[ "${VISION_CLOUD_DISABLE_TIMEOUT:-0}" == 1 ]]; then
    "$@"
    return
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout --foreground --kill-after=10s "$duration" "$@"
    return
  fi

  cloud_log "WARNING: timeout(1) is unavailable; running foreground command without an external deadline: $1" >&2
  "$@"
}

cloud_run_with_heartbeat() {
  local duration="$1"
  local interval="$2"
  local label="$3"
  shift 3

  (
    while sleep "$interval"; do
      cloud_log "WAIT: $label is still running."
    done
  ) &
  local heartbeat_pid=$!

  local status=0
  cloud_run_with_timeout "$duration" "$@" || status=$?
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true
  return "$status"
}

cloud_run_with_foreground_heartbeat() {
  local duration="$1"
  local interval="$2"
  local label="$3"
  shift 3

  (
    while sleep "$interval"; do
      cloud_log "WAIT: $label is still running."
    done
  ) &
  local heartbeat_pid=$!

  local status=0
  cloud_run_with_foreground_timeout "$duration" "$@" || status=$?
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true
  return "$status"
}

cloud_run_package_with_heartbeat() {
  local duration="$1"
  local interval="$2"
  local label="$3"
  shift 3

  (
    while sleep "$interval"; do
      cloud_log "WAIT: $label is still running."
    done
  ) &
  local heartbeat_pid=$!

  local status=0
  cloud_run_package_with_timeout "$duration" "$@" || status=$?
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true
  return "$status"
}

cloud_run_step() {
  local label="$1"
  shift
  local started_at=$SECONDS

  cloud_log "START: $label"
  if "$@"; then
    cloud_log "DONE: $label ($((SECONDS - started_at))s)"
    return 0
  else
    local status=$?
    cloud_log "FAILED: $label after $((SECONDS - started_at))s (exit $status)"
    return "$status"
  fi
}

cloud_docker_daemon_available() {
  command -v docker >/dev/null 2>&1 || return 1
  cloud_run_with_timeout 8s docker info >/dev/null 2>&1
}

cloud_hash_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
    return
  fi

  cloud_log 'Neither sha256sum nor shasum is available.' >&2
  return 1
}

cloud_fingerprint() {
  local version="$1"
  shift

  {
    printf 'cache-version=%s\n' "$version"
    for file in "$@"; do
      printf 'file=%s\n' "$file"
      if [[ -f "$file" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
          printf '%s\n' "$line"
        done < "$file"
      else
        printf '<missing>\n'
      fi
    done
  } | cloud_hash_stream
}

cloud_marker_matches() {
  local marker="$1"
  local expected="$2"
  [[ -f "$marker" ]] && [[ "$(<"$marker")" == "$expected" ]]
}

cloud_write_marker() {
  local marker="$1"
  local value="$2"
  local temporary="${marker}.tmp.$$"

  printf '%s\n' "$value" > "$temporary"
  mv "$temporary" "$marker"
}
