---
title: Mac Performance Baseline
type: performance
status: active
date: 2026-10-25
last_modified: 2026-10-25
tags: [performance, macos, gpu, energy, measurement, electron]
description: Repeatable before/after measurement of the installed Vision apps on a Mac (memory, CPU, GPU, power, launch, frames) across the three UI tiers
aliases: [mac baseline, performance baseline, powermetrics run]
related_code: ["scripts/mac-baseline.ts", "scripts/lib/mac-baseline/", "apps/native/VisionNative/PerfRun.swift", "apps/native/Sources/VisionNativeCore/Perf/PerfRunModel.swift"]
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

Results land in `perf-results/<timestamp>/` of the main checkout (git-ignored), also when the
script runs from a linked worktree: `results.json`, `summary.md`,
`powermetrics.jsonl`, `traces/*.json.gz` (open in Perfetto or Chrome DevTools) and app logs.
`bun scripts/mac-baseline.ts --help` lists the options (`--app`, `--tiers`, `--idle`,
`--sustained`, `--cooldown`, `--pages`, `--full-effects`, `--repeat`, `--no-powermetrics`,
`--no-trace`, `--launch-probe`, `--leak`, `--leak-window`).

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

## Native app

The Swift app (`apps/native`) is measured with the same procedure so its numbers sit next to the
Electron ones. It has no DevTools port, so the app runs its own scripted scenario and writes the
result; the script launches it, samples its processes and joins both.

```sh
bun scripts/mac-baseline.ts --native                      # Vision Native Demo and Vision Native when installed
bun scripts/mac-baseline.ts --native-app "/Applications/Vision Native Demo.app" --quick
bun scripts/mac-baseline.ts --native --app "/Applications/Vision Demo.app"   # Electron and native in one run
```

`--native` replaces the default Electron apps (an explicit `--app` keeps them). `--idle`,
`--sustained`, `--cooldown`, `--quick` and `--no-powermetrics` apply as above; the native app's own
defaults are a 30 s idle window and a 60 s sustained loop. `--tiers`, `--full-effects`,
`--repeat`, `--scroll-px`, `--pages` and `--no-trace` do not apply. `--compare <dir>` picks the
Electron run to compare with; by default it is the newest run in `perf-results/` that measured
Electron apps (then the `perf-results/` of the repository's other git worktrees, so a build in a
linked worktree compares with runs recorded in the main checkout), using the same edition (Vision Demo for Vision Native Demo), Full effects on, and
the standard tier.

**What the app does** (`VisionPerfRun`, `apps/native/VisionNative/PerfRun.swift`): waits for the
shell to be ready (launch to ready is measured from the process start time), settles 10 s, idles
on Home, scrolls the largest scroll view on Transactions down and back up at 1500 px/s for about
10 s, switches over the same six pages as the script twice with the Go menu's navigation, then runs
the sustained scroll/switch loop. It records display-link frame timestamps for every window except
idle (the link stays off there so it does not add wakeups), frames later than 1.5x the refresh
interval as hitches, the process's own CPU time (`getrusage`) and `phys_footprint`
(`proc_pid_rusage`) per window, and writes `results.json` to the directory it was given. It deletes the
persistent setting as soon as the run starts (a crashed run never repeats) and quits at the end, so
the next normal launch is clean. When it is not set, the only cost is one
`UserDefaults` read at launch.

**What the script adds:** 1 s `ps` samples of the Swift app, its Bun backend and PostgreSQL (found
through the runtime's `backend.pid.json` and `postgres.pid.json`) matched to each window for CPU
per role, `footprint(1)` samples every 15 s for the backend and PostgreSQL, and the powermetrics
slice for each window. Frame statistics reuse `computeFrameStats` and `fpsBuckets`, so FPS,
dropped %, p95 and frames over 50 ms mean the same as for Electron. Results go to
`<run>/results.json` (key `native`), a per-app folder holding the app's raw `results.json`, and the
"Native app (Swift)" section of `summary.md` with the side-by-side table. When the same run also
measured Electron apps, the table compares with those.

**Profiling pass.** After the measured runs the script launches each native app once more and
attaches `sample` while it idles (8 s), scrolls (3 s) and switches pages (6 s); the app
writes the running phase to `phase.txt` in its output folder. Sampling stops threads, so this run
is not measured: it only lists the heaviest busy leaf frames and the app's own frames with their
inclusive counts under "hot spots" in the app's part of `summary.md`, with the full reports beside them
(`<app>-profile/<phase>.sample.txt`). `--no-profile` skips it.

**Without arguments.** UserDefaults reads launch arguments and the app's defaults domain alike, so
the run can also start from a normal launch:

```sh
defaults write com.vaultvoyager.vision-native-demo VisionPerfRun /tmp/vision-perf
open -a "Vision Native Demo"          # runs, writes /tmp/vision-perf/results.json, quits
# or: open -a "Vision Native Demo" --args -VisionPerfRun /tmp/vision-perf -VisionPerfIdleSeconds 10
```

`VisionPerfIdleSeconds` and `VisionPerfSustainedSeconds` override the window lengths. Without the
script no power or backend numbers are collected; read `results.json` for the app's own frames,
CPU and footprint. Keep the window in front and the Mac awake, as for the Electron run.

> [!note] Comparing frames
> Electron frames are `requestAnimationFrame` callbacks, which fire only when the page draws.
> Native frames are display-link ticks on the main window, which fire every refresh while the main
> thread is free, so a native frame count shows main-thread stalls (hitches) more than it shows
> skipped draws. Compare GPU and power, CPU, and the hitch counts as well as FPS, and confirm
> smoothness by eye.

## Related

- [[docs/performance/index|Performance Documentation]]
