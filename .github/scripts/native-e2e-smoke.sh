#!/usr/bin/env bash
# Launches a built Debug "Vision Native Demo.app" (with its staged runtime payload) in the
# ADR-207 helper-document mode and checks that the supervised runtime starts, the helper
# document bootstraps and the app keeps running. Synthetic Demo data only.
set -euo pipefail

app="$1"
out="$2"
mode="${3:-helper}"
mkdir -p "$out"
binary="$app/Contents/MacOS/Vision Native Demo"
[ -x "$binary" ] || { echo "missing app binary: $binary"; exit 1; }

started="$(date '+%Y-%m-%d %H:%M:%S')"
if [ "$mode" = "helper" ]; then
  VISION_NATIVE_HELPER_DOCUMENT=1 "$binary" >"$out/app-$mode.log" 2>&1 &
else
  "$binary" >"$out/app-$mode.log" 2>&1 &
fi
pid=$!

logs() {
  log show --start "$started" --style compact --info --debug \
    --predicate 'subsystem == "com.vaultvoyager.vision-native"' 2>/dev/null || true
}

status=1
for _ in $(seq 1 120); do
  sleep 3
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "::error::the app exited early"
    break
  fi
  current="$(logs)"
  if [ "$mode" = "helper" ]; then
    if grep -q "helper document .* failed" <<<"$current"; then
      echo "::error::the helper document failed"
      break
    fi
    if grep -q "helper document ready" <<<"$current"; then status=0; break; fi
  else
    if grep -q "phase running" <<<"$current"; then sleep 15; status=0; break; fi
  fi
done

if [ "$status" = "0" ]; then
  # Let native screens settle, then require the process to stay alive.
  sleep 20
  kill -0 "$pid" 2>/dev/null || { echo "::error::the app exited after startup"; status=1; }
  screencapture -x "$out/screen-$mode.png" || true
fi

# A graceful Quit runs the app's own shutdown (quit backup, runtime stop); Apple events may be
# blocked on the runner, so it is bounded and falls back to signals. Not part of the verdict.
perl -e 'alarm 20; exec @ARGV' osascript -e 'tell application "Vision Native Demo" to quit' \
  >/dev/null 2>&1 || echo "graceful quit unavailable; falling back to SIGTERM"
for _ in $(seq 1 45); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
kill -KILL "$pid" 2>/dev/null || true

logs >"$out/os-$mode.log"
grep -E "\[shell\]|\[runtime\]|\[renderer\]|\[backup\]|\[notify\]|helper|[Ss]hutdown" "$out/os-$mode.log" | tail -100 || true
exit "$status"
