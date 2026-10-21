import assert from "node:assert/strict";
import test from "node:test";

import { computeFrameStats, fpsBuckets } from "../lib/mac-baseline/frames.ts";
import {
  extractSample,
  parsePlist,
  splitPlistDocuments,
  summarizePower,
} from "../lib/mac-baseline/powermetrics.ts";
import {
  classifyProcesses,
  parseCpuTime,
  parsePsOutput,
  parseTopMem,
  summarizeRoles,
} from "../lib/mac-baseline/processes.ts";
import { findSegments, summarizeTrace } from "../lib/mac-baseline/trace.ts";

test("parses macOS and procps CPU times", () => {
  assert.equal(parseCpuTime("0:01.50"), 1.5);
  assert.equal(parseCpuTime("125:03.25"), 7503.25);
  assert.equal(parseCpuTime("00:01:02"), 62);
  assert.equal(parseCpuTime("1-00:00:01"), 86_401);
});

const PS = `
  100     1  204800   1:00.00 /Applications/Vision.app/Contents/MacOS/Vision --remote-debugging-port=9333
  101   100  102400   0:30.00 /Applications/Vision.app/Contents/Frameworks/Vision Helper (GPU).app/Contents/MacOS/Vision Helper (GPU) --type=gpu-process
  102   100  307200   2:00.00 /Applications/Vision.app/Contents/Frameworks/Vision Helper (Renderer).app/Contents/MacOS/Vision Helper (Renderer) --type=renderer
  103   100   51200   0:01.00 /Applications/Vision.app/Contents/Frameworks/Vision Helper.app/Contents/MacOS/Vision Helper --type=utility --utility-sub-type=network.mojom.NetworkService
  104   100   81920   0:10.00 /Applications/Vision.app/Contents/Resources/resources/native-runtime/vision-backend
  105   100   40960   0:05.00 /Applications/Vision.app/Contents/Resources/resources/native-runtime/postgres/bin/postgres -D /x -p 5433
  106   105   10240   0:01.00 postgres: checkpointer
  200     1  512000   5:00.00 /Applications/Ollama.app/Contents/Resources/ollama serve
  201   200 4096000  10:00.00 /Applications/Ollama.app/Contents/Resources/ollama runner --model x
  300     1   20480  50:00.00 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  400     1    1024   0:00.10 /usr/bin/unrelated
`;

test("classifies Vision, runtime, Ollama and WindowServer processes", () => {
  const rows = parsePsOutput(PS);
  assert.equal(rows.length, 11);
  const roles = classifyProcesses(rows, {
    mainPid: 100,
    backendPid: 104,
    postgresPid: 105,
  });
  assert.deepEqual(Object.fromEntries([...roles].sort((a, b) => a[0] - b[0])), {
    100: "main",
    101: "gpu",
    102: "renderer",
    103: "network",
    104: "backend",
    105: "postgres",
    106: "postgres",
    200: "ollama",
    201: "ollama",
    300: "windowserver",
  });
  // Without pid files the runtime children are recognised by executable name.
  const fallback = classifyProcesses(rows, { mainPid: 100 });
  assert.equal(fallback.get(104), "backend");
  assert.equal(fallback.get(105), "postgres");
});

test("computes CPU % from CPU-time deltas and sums app roles", () => {
  const before = parsePsOutput(PS);
  const after = before.map((row) =>
    row.pid === 102
      ? { ...row, cpuSeconds: row.cpuSeconds + 5 }
      : row.pid === 101
        ? { ...row, cpuSeconds: row.cpuSeconds + 1 }
        : row,
  );
  const roles = classifyProcesses(after, {
    mainPid: 100,
    backendPid: 104,
    postgresPid: 105,
  });
  const summary = summarizeRoles(after, roles, { before, wallSeconds: 10 });
  assert.equal(summary.renderer?.cpuPercent, 50);
  assert.equal(summary.gpu?.cpuPercent, 10);
  assert.equal(summary.appTotal?.cpuPercent, 60);
  assert.equal(summary.appTotal?.processes, 7);
  assert.equal(summary.postgres?.rssMb, 50);
  assert.equal(summary.ollama?.processes, 2);
});

test("reads top's MEM footprint column", () => {
  const top = `Processes: 500 total\nPID    MEM\n100    210M+\n101    1024K\n102    1.5G-\n`;
  const mem = parseTopMem(top);
  assert.equal(mem.get(100), 210 * 1024 ** 2);
  assert.equal(mem.get(101), 1024 * 1024);
  assert.equal(mem.get(102), 1.5 * 1024 ** 3);
});

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>elapsed_ns</key><integer>1000000000</integer>
  <key>timestamp</key><date>2026-10-21T16:00:00Z</date>
  <key>thermal_pressure</key><string>Nominal</string>
  <key>processor</key>
  <dict>
    <key>cpu_energy</key><integer>800</integer>
    <key>ane_power</key><real>0</real>
    <key>combined_power</key><real>2400.5</real>
    <key>clusters</key><array><dict><key>name</key><string>E-Cluster</string><key>cpus</key><array/></dict></array>
  </dict>
  <key>gpu</key>
  <dict>
    <key>freq_hz</key><real>708000000</real>
    <key>idle_ratio</key><real>0.25</real>
    <key>gpu_energy</key><integer>1500</integer>
  </dict>
  <key>tasks</key>
  <array>
    <dict><key>pid</key><integer>101</integer><key>name</key><string>Vision Helper (GPU)</string><key>cputime_ms_per_s</key><real>40</real><key>gputime_ms_per_s</key><real>300</real></dict>
    <dict><key>pid</key><integer>102</integer><key>name</key><string>Vision Helper (GPU)</string><key>cputime_ms_per_s</key><real>10</real><key>gputime_ms_per_s</key><real>100</real></dict>
    <dict><key>pid</key><integer>7</integer><key>name</key><string>Safari &amp; Co</string><key>cputime_ms_per_s</key><real>99</real></dict>
    <dict><key>pid</key><integer>300</integer><key>name</key><string>WindowServer</string><key>cputime_ms_per_s</key><real>20</real><key>flag</key><true/></dict>
  </array>
</dict>
</plist>
`;

test("parses powermetrics plist samples", () => {
  const { documents, rest } = splitPlistDocuments(
    `${SAMPLE}\0${SAMPLE}\0<?xml`,
  );
  assert.equal(documents.length, 2);
  assert.equal(rest, "\n\0<?xml");
  const sample = extractSample(parsePlist(documents[0] as string), 5000);
  assert.equal(sample.elapsedMs, 1000);
  assert.equal(sample.cpuPowerMw, 800);
  assert.equal(sample.gpuPowerMw, 1500);
  assert.equal(sample.combinedPowerMw, 2400.5);
  assert.equal(sample.gpuFreqMhz, 708);
  assert.equal(sample.gpuActivePercent, 75);
  assert.equal(sample.thermalPressure, "Nominal");
  assert.deepEqual(
    sample.tasks.map((task) => task.name),
    ["Vision Helper (GPU)", "Vision Helper (GPU)", "WindowServer"],
  );
  const summary = summarizePower([
    sample,
    { ...sample, gpuActivePercent: 25, receivedAt: 6000 },
  ]);
  assert.equal(summary.samples, 2);
  assert.equal(summary.gpuActivePercent, 50);
  assert.equal(summary.gpuActivePercentMax, 75);
  assert.deepEqual(summary.thermalPressure, { Nominal: 2 });
  assert.deepEqual(summary.tasks["Vision Helper (GPU)"], {
    cpuMsPerS: 50,
    gpuMsPerS: 400,
    energyImpactPerS: null,
  });
});

test("frame stats count missed vsyncs from rAF intervals", () => {
  // 60 Hz frames with one 50 ms hitch (two missed vsyncs).
  const stamps = [0];
  for (let i = 1; i <= 30; i++)
    stamps.push((stamps.at(-1) as number) + (i === 15 ? 50 : 16.67));
  const stats = computeFrameStats({
    stamps,
    loaf: [{ duration: 60, blocking: 10 }],
  });
  assert.equal(stats.frames, 31);
  assert.equal(stats.refreshMs, 16.7);
  assert.equal(stats.droppedFrames, 2);
  assert.equal(stats.longFrames, 0);
  assert.equal(stats.longAnimationFrames, 1);
  assert.equal(stats.blockingMs, 10);
  assert.deepEqual(fpsBuckets([0, 100, 200, 1100, 1900, 2100], 1000), [3, 2]);
});

test("trace summaries split at page markers", () => {
  const events = [
    { ph: "M", name: "process_name", pid: 1, args: { name: "Renderer" } },
    {
      ph: "M",
      name: "thread_name",
      pid: 1,
      tid: 2,
      args: { name: "CrRendererMain" },
    },
    {
      ph: "I",
      name: "TimeStamp",
      pid: 1,
      tid: 2,
      ts: 1000,
      args: { data: { message: "vision-perf:scroll:start" } },
    },
    {
      ph: "X",
      name: "ThreadControllerImpl::RunTask",
      cat: "toplevel",
      pid: 1,
      tid: 2,
      ts: 1100,
      dur: 4000,
    },
    {
      ph: "X",
      name: "Paint",
      cat: "devtools.timeline",
      pid: 1,
      tid: 2,
      ts: 1200,
      dur: 2000,
    },
    {
      ph: "b",
      name: "PipelineReporter",
      pid: 1,
      tid: 2,
      ts: 1300,
      args: {
        frame_reporter: {
          state: "STATE_DROPPED",
          has_compositor_animation: true,
        },
      },
    },
    {
      ph: "I",
      name: "TimeStamp",
      pid: 1,
      tid: 2,
      ts: 11_000,
      args: { data: { message: "vision-perf:scroll:end" } },
    },
    {
      ph: "X",
      name: "Paint",
      cat: "devtools.timeline",
      pid: 1,
      tid: 2,
      ts: 20_000,
      dur: 9000,
    },
  ];
  const segments = findSegments(events);
  assert.deepEqual(segments.get("scroll"), { start: 1000, end: 11_000 });
  const summary = summarizeTrace(events, segments.get("scroll"));
  assert.equal(summary.durationMs, 10);
  assert.deepEqual(summary.threadBusyMs, { "Renderer 1/CrRendererMain": 4 });
  assert.deepEqual(summary.frameStates, {
    "Renderer 1": { STATE_DROPPED: 1, with_compositor_animation: 1 },
  });
  assert.deepEqual(summary.rendererTopEvents, [
    { name: "Paint", count: 1, totalMs: 2 },
  ]);
});
