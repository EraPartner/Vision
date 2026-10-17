#!/usr/bin/env bash
# Launches a built Debug "Vision Native Demo.app" (with its staged runtime payload) and checks
# that the supervised runtime starts and the app keeps running: in the retained mode the
# backend must answer /health; in the ADR-207 helper mode the helper document must also report
# ready. Synthetic Demo data only. Every run leaves the unified log stream and the tails of the
# app's own logs in "$out" and in the job log.
set -euo pipefail

app="$1"
out="$2"
mode="${3:-helper}"
mkdir -p "$out"
# `electron` measures the Electron Vision Demo with the same readiness and metrics, as the
# phase-0 baseline that ADR-204's phase-4 exit compares with.
name="Vision Native Demo"
[ "$mode" = "electron" ] && name="Vision Demo"
binary="$app/Contents/MacOS/$name"
[ -x "$binary" ] || { echo "missing app binary: $binary"; exit 1; }
data="$HOME/Library/Application Support/$name"

stream="$out/stream-$mode.log"
log stream --style compact --level debug \
  --predicate 'subsystem == "com.vaultvoyager.vision-native"' >"$stream" 2>&1 &
stream_pid=$!
sleep 2

if [ "$mode" = "helper" ]; then
  VISION_NATIVE_HELPER_DOCUMENT=1 "$binary" >"$out/app-$mode.log" 2>&1 &
else
  "$binary" >"$out/app-$mode.log" 2>&1 &
fi
pid=$!

app_logs() {
  cat "$stream" "$data/logs/main.log" 2>/dev/null || true
}

backend_healthy() {
  local port
  port="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("appPort", ""))' \
    "$data/settings.json" 2>/dev/null || true)"
  [ -n "$port" ] && curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$port/health"
}

status=1
for _ in $(seq 1 100); do
  sleep 3
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "::error::the app exited early"
    break
  fi
  current="$(app_logs)"
  if [ "$mode" = "helper" ] && grep -q "helper document .* failed" <<<"$current"; then
    echo "::error::the helper document failed"
    break
  fi
  backend_healthy || continue
  if [ "$mode" = "helper" ]; then
    grep -q "helper document ready" <<<"$current" && { status=0; break; }
  else
    status=0
    break
  fi
done
[ "$status" = "0" ] || echo "::error::$mode smoke did not reach its ready state"

# Resident memory (KiB) of the app, its descendants (backend, PostgreSQL) and WebKit's
# content/networking services, plus the app bundle size: the ADR-204 phase-4 comparison.
measure() {
  local pids=("$pid") frontier=("$pid") next child total=0 app_rss webkit
  while [ "${#frontier[@]}" -gt 0 ]; do
    next=()
    for parent in "${frontier[@]}"; do
      while read -r child; do [ -n "$child" ] && next+=("$child") && pids+=("$child"); done \
        < <(pgrep -P "$parent" 2>/dev/null || true)
    done
    frontier=("${next[@]+"${next[@]}"}")
  done
  for p in "${pids[@]}"; do total=$((total + $(ps -o rss= -p "$p" 2>/dev/null || echo 0))); done
  app_rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)"
  webkit="$(ps -axo rss=,comm= | awk '/com\.apple\.WebKit\.(WebContent|Networking|GPU)/ {s+=$1} END {print s+0}')"
  {
    echo "mode=$mode"
    echo "bundle_kib=$(du -sk "$app" | cut -f1)"
    echo "app_rss_kib=$app_rss"
    echo "app_tree_rss_kib=$total"
    echo "webkit_rss_kib=$webkit"
    echo "processes=${#pids[@]}"
  } | tee "$out/metrics-$mode.txt"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### $mode metrics"; echo '```'; cat "$out/metrics-$mode.txt"; echo '```'; } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ "$status" = "0" ]; then
  # Let native screens settle, then require the process to stay alive.
  sleep 20
  kill -0 "$pid" 2>/dev/null || { echo "::error::the app exited after startup"; status=1; }
  screencapture -x "$out/screen-$mode.png" || true
  measure || true
fi

# A graceful Quit runs the app's own shutdown (quit backup, runtime stop); Apple events may be
# blocked on the runner, so it is bounded and falls back to signals. Not part of the verdict.
perl -e 'alarm 20; exec @ARGV' osascript -e "tell application \"$name\" to quit" \
  >/dev/null 2>&1 || echo "graceful quit unavailable; falling back to SIGTERM"
for _ in $(seq 1 45); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
kill -KILL "$pid" 2>/dev/null || true
kill "$stream_pid" 2>/dev/null || true

for file in "$data/logs/main.log" "$data"/native/*/logs/backend.log "$data"/native/*/logs/postgres.log; do
  [ -f "$file" ] || continue
  cp "$file" "$out/$mode-$(basename "$file")"
  echo "::group::$mode $(basename "$file") (tail)"
  tail -60 "$file"
  echo "::endgroup::"
done
echo "::group::$mode unified log (shell/runtime lines)"
grep -E "\[shell\]|\[runtime\]|\[renderer\]|\[backup\]|\[notify\]|helper|[Ss]hutdown|error" "$stream" | tail -120 || true
echo "::endgroup::"
exit "$status"
