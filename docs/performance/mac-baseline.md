---
title: Mac Performance Baseline
type: performance
status: active
date: 2026-10-26
last_modified: 2026-10-26
tags: [performance, macos, gpu, energy, measurement, electron]
description: Repeatable before/after measurement of the installed Vision apps on a Mac (memory, CPU, GPU, power, launch, frames) across the three UI tiers
aliases: [mac baseline, performance baseline, powermetrics run]
related_code: ["scripts/mac-baseline.ts", "scripts/lib/mac-baseline/"]
---

# Mac Performance Baseline

`scripts/mac-baseline.ts` measures the installed `Vision.app` and `Vision Demo.app` so every
optimisation can report before/after numbers from the same procedure. It runs in your own
Terminal on the Mac, never in CI.

## What it does

- Launches the app binary with Chromium's `--remote-debugging-port` switch on a free loopback
  port. That switch is a launch argument only: normal launches, the packaged fuses, the renderer
  sandbox and the CSP are unchanged, and the app code has no measurement hook.
- Sets each UI tier (`reduced`, `standard`, `enhanced`), and optionally the Full effects switch,
  through the app's own `/api/settings/app_settings` endpoint, quits, waits a cooldown, and relaunches, so each tier is
  measured from a fresh launch. The original setting is restored at the end, also after Ctrl-C.
- Runs one `sudo powermetrics` stream (`cpu_power,gpu_power,thermal,tasks`, 1 s samples) for the
  whole run and slices it per phase.
- Per tier: launch time to `renderer_ready`, memory footprint per process role, an idle window on
  the Dashboard (no page scripting, so frame recording does not wake the page), a ledger scroll on
  `/transactions` (a compositor scroll gesture), two passes of page switches, a separate
  Chromium-traced pass, and a sustained scroll/switch loop that compares the first and last minute
  for thermal throttling.

Process roles: Electron main, renderer, GPU process, network and other utility processes, the
Bun backend and PostgreSQL (found through the native runtime's pid files), Ollama, and
WindowServer (compositing cost lands there). CPU % is CPU time per wall second over the window
(100% = one core).

## Run it

1. Quit Vision and Vision Demo. Close other heavy apps. Keep the Mac on the power adapter, Low
   Power Mode off, and the same window size as last time.
2. From the checkout:

   ```bash
   bun scripts/mac-baseline.ts --quick --tiers standard   # ~5 min smoke run
   bun scripts/mac-baseline.ts                            # full run, about an hour
   bun scripts/mac-baseline.ts --full-effects off,on --repeat 3   # switch off vs on, 3 runs each
   ```

3. Enter the sudo password once when asked (for `powermetrics`). Leave the Vision window in front
   until the run ends; an unfocused window pauses the aurora and the run reports a warning.

Results land in `perf-results/<timestamp>/` (git-ignored): `results.json`, `summary.md`,
`powermetrics.jsonl`, `traces/*.json.gz` (open in Perfetto or Chrome DevTools) and app logs.
`bun scripts/mac-baseline.ts --help` lists the options (`--app`, `--tiers`, `--idle`,
`--sustained`, `--cooldown`, `--pages`, `--full-effects`, `--repeat`, `--no-powermetrics`,
`--no-trace`, `--idle-trace`, `--variant`, `--variants-only-idle`, `--launch-probe`,
`--background`, `--leak`, `--leak-window`).

## Idle renderer work and background windows

The idle window also records the renderer's `Performance.getMetrics` deltas (`ScriptDurationMs`,
`TaskDurationMs`, ...) and the number of resource requests the page starts, so timer and poll
changes show up even when total CPU is noisy. `--background <s>` adds a window right after idle in
which Finder is frontmost and Vision stays visible behind it; Vision is brought back to the front
afterwards. The spread table compares idle and background renderer work, renderer and GPU memory
after the sustained run, JS heap used and DOM node count (ADR-256). After 5 min without real
keyboard or mouse input macOS reports the user as idle and Vision pauses its React Query polls, so
long unattended phases run in that state.

## Launch probe

`--launch-probe <s>` adds a diagnostic step right after each launch, before the 10 s settle. For
`<s>` seconds, without any input, it records which page animations are running (every 5 s, from
`document.getAnimations()`), every page request (path, count, failures, still open, longest
time), and per-process CPU plus powermetrics GPU over the same window. It writes
`launch-probe/<label>.json` with the last 200 lines of the backend log and prints the top
animations and requests. It was added to find the post-launch GPU burn on the real app
([[docs/adr/247-launch-background-work-bounds|ADR-247]]). It delays the idle window, so leave it off
for before/after runs:

```bash
bun scripts/mac-baseline.ts --app /Applications/Vision.app --tiers reduced,standard \
  --launch-probe 90 --idle 10 --sustained 0 --no-trace
```

## Backend and PostgreSQL memory

Footprint per role adds up each process, so memory several PostgreSQL processes map (the shared
buffers) is counted once per process that touched it. The summary's "Backend and PostgreSQL
memory" table therefore also runs `footprint <pids…>` over each role's processes together, which
counts shared memory once ("shared once"), and lists the PostgreSQL process count. The headline
spread table reports both shared-once values after launch.

## Leak check

```bash
bun scripts/mac-baseline.ts --leak 45 --app /Applications/Vision.app
```

One launch of the first app at its current tier (no setting changes, no sudo). It alternates
`--leak-window` seconds (default 300) of the sustained scroll/switch loop with the same time idle
on the Dashboard and samples memory every 30 s. After a 10-minute warm-up it judges the idle
samples only: "rising" needs the idle-window medians to go up across each of the last three
windows and a least-squares slope above 1 MB/min; otherwise "flat", or "too short" with fewer
than three idle windows (45 minutes is enough). Output: `leak.md`, `leak.csv` and `leak.json`.
Backend and PostgreSQL decide the verdict; renderer and GPU process are recorded for later phases.

## Full effects and repeats

`--full-effects off,on` measures every tier with the "Full effects" switch
([[docs/adr/244-full-effects-switch|ADR-244]]) off and on; the script writes `fullEffects` with the
tier and checks the window's `fx-full` class. `--repeat <n>` measures every tier and switch
combination n times, each from a fresh launch, with the repeats as the outer loop so drift spreads
over all combinations. The summary opens with a headline table per app and tier: median and
min–max per switch state, the change of the medians, and "beyond noise" only when the off and on
ranges do not overlap (at least two runs per side). Later phases use the same rule before they
claim a win.

## Variants (phase D, ADR-255)

`--variant <name>=<file>` (repeatable) adds a variant axis next to tier and switch: after launch
the script sets `<html data-fx-variant="<name>">` and injects the file (`.css` as a style element,
`.js` evaluated), then measures. `base` (no injection) is always measured. Relative files resolve
from the working directory, then `scripts/mac-baseline-variants/`: `drift-10/20/30/60` (aurora
cadence with Full effects), `glass-blur` (the pre-ADR-255 card and sidebar blur), `no-hover-fade`
and `shader-standard` (WebGL aurora on standard; pair with `--tiers standard`).
`--variants-only-idle` runs only the idle window for variant runs. The summary adds a
"Variants vs base" table with the same beyond-noise rule.

Every run now also reports the idle frame rate (presented frames per second from a 10 s trace at
the end of the idle window; on by default, `--no-trace` skips it unless `--idle-trace` is given)
and a glass census (`glass area %` and `glass surfaces`: elements with a backdrop filter, clipped
to the viewport; nested surfaces add up, so area can exceed 100%).

> [!warning] Side effects
> Each app is launched once per tier plus once for setup. If backup-on-quit is enabled, every
> quit writes a backup. The traced pass and the remote debugging port exist only while the script
> runs.

## Reading the numbers

- GPU active % and GPU/package power come from `powermetrics` and cover the whole machine, so
  close other apps. Per-process GPU ms/s for Vision, WindowServer and Ollama are in
  `results.json` under each phase's `power.tasks`.
- Dropped frames are counted from `requestAnimationFrame` intervals against the measured refresh
  interval; the trace pass adds Chromium's own frame states (`STATE_PRESENTED_ALL`,
  `STATE_DROPPED`, ...).
- The first page-switch pass includes lazy route chunks and cold queries; the second is warm.
- `powermetrics` key names vary across macOS releases. `results.json` lists the keys seen, and
  `powermetrics.jsonl` keeps each sample's raw processor and GPU dictionaries for re-parsing.

## Related

- [[docs/performance/index|Performance Documentation]]
