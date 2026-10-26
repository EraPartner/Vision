import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonMetrics,
  deltaPercent,
  memoryAt,
  nearestSample,
  parseNativePerfResults,
  parseSampleReport,
  pickElectronReference,
  renderHotSpots,
  renderNativeSection,
  runNamesNewestFirst,
  summarizeNativeRun,
  windowCpu,
  type MemorySample,
  type NativePerfResults,
  type PsSample,
} from "../lib/mac-baseline/native.ts";
import type { ProcessRole, PsRow } from "../lib/mac-baseline/processes.ts";
import type {
  BaselineResults,
  TierResult,
} from "../lib/mac-baseline/report.ts";

const APP = {
  path: "/Applications/Vision Native Demo.app",
  name: "Vision Native Demo",
  bundleId: "com.vaultvoyager.vision-native-demo",
  version: "1.0.0",
  bundleMtime: "2026-10-25T00:00:00.000Z",
  sizeMb: 100,
  sizeBreakdownMb: {},
};

function psRow(pid: number, cpuSeconds: number): PsRow {
  return { pid, ppid: 1, rssKb: 1024, cpuSeconds, command: `proc ${pid}` };
}

function psSample(
  t: number,
  main: number,
  backend: number,
  postgres: number,
): PsSample {
  return {
    t,
    rows: [psRow(10, main), psRow(11, backend), psRow(12, postgres)],
    roles: new Map<number, ProcessRole>([
      [10, "main"],
      [11, "backend"],
      [12, "postgres"],
    ]),
  };
}

/** 60 fps for two seconds with one 60 ms stall in the middle. */
function stamps(): number[] {
  const out: number[] = [0];
  for (let index = 1; index <= 120; index++) {
    const gap = index === 60 ? 60 : 16.7;
    out.push((out.at(-1) as number) + gap);
  }
  return out;
}

function nativeResults(): NativePerfResults {
  const phase = (
    name: "idle" | "scroll" | "pageSwitch" | "sustained",
    startEpochMs: number,
    endEpochMs: number,
    framed: boolean,
  ) => ({
    name,
    startEpochMs,
    endEpochMs,
    wallMs: endEpochMs - startEpochMs,
    cpuSeconds: 0.3,
    cpuUserSeconds: 0.2,
    cpuSystemSeconds: 0.1,
    footprintStartMb: 400,
    footprintEndMb: 410,
    framesTracked: framed,
    frameStampsMs: framed ? stamps() : [],
    frames: framed
      ? { frames: 121, refreshMs: 16.7, hitches: 1, maxIntervalMs: 60 }
      : null,
    steps:
      name === "pageSwitch"
        ? [
            { path: "/", settleMs: 40, timedOut: false },
            { path: "/accounts", settleMs: 80, timedOut: false },
          ]
        : [],
    scroll:
      name === "scroll"
        ? { found: true, distancePx: 7500, durationMs: 10_000 }
        : null,
    cycles: name === "sustained" ? 3 : null,
    windowVisibleAtEnd: true,
    appActiveAtEnd: true,
  });
  return {
    schemaVersion: 1,
    app: {
      name: APP.name,
      bundleIdentifier: APP.bundleId,
      variant: "demo",
      version: "1.0.0",
      pid: 10,
    },
    machine: {
      maximumFramesPerSecond: 120,
      backingScale: 2,
      windowPixelsWide: 2880,
      windowPixelsHigh: 1800,
      lowPowerMode: false,
      thermalState: 0,
    },
    options: { idleSeconds: 30, sustainedSeconds: 60 },
    processStartEpochMs: 1_000,
    readyEpochMs: 3_500,
    launchToReadyMs: 2_500,
    afterLaunch: { cpuSeconds: 2, footprintMb: 380 },
    phases: [
      phase("idle", 20_000, 30_000, false),
      phase("scroll", 32_000, 42_000, true),
      phase("pageSwitch", 44_000, 54_000, true),
      phase("sustained", 56_000, 66_000, true),
    ],
    error: null,
  };
}

test("parses a native results.json and fills the optional fields", () => {
  const text = JSON.stringify({
    ...nativeResults(),
    machine: undefined,
    error: undefined,
  });
  const parsed = parseNativePerfResults(text);
  assert.equal(parsed.machine, null);
  assert.equal(parsed.error, null);
  assert.equal(parsed.phases.length, 4);
  assert.throws(() => parseNativePerfResults("{"), /not JSON/);
  assert.throws(
    () => parseNativePerfResults(JSON.stringify({ schemaVersion: 2 })),
    /schemaVersion 1/,
  );
  assert.throws(
    () =>
      parseNativePerfResults(
        JSON.stringify({
          schemaVersion: 1,
          app: {},
          phases: [{ name: "bogus" }],
        }),
      ),
    /malformed phase/,
  );
});

test("matches process samples to a window by the nearest samples", () => {
  const samples = [
    psSample(0, 10, 5, 4),
    psSample(1_000, 10.5, 5.1, 4.1),
    psSample(11_000, 15.5, 5.6, 4.6),
    psSample(12_000, 16, 5.7, 4.7),
  ];
  assert.equal(nearestSample(samples, 900)?.t, 1_000);
  assert.equal(nearestSample([], 1), null);
  // 1.2 s → 10.8 s: nearest samples at 1 s and 11 s, 10 s apart.
  const cpu = windowCpu(samples, 1_200, 10_800);
  assert.equal(cpu?.main?.cpuPercent, 50);
  assert.equal(cpu?.backend?.cpuPercent, 5);
  assert.equal(cpu?.appTotal?.cpuPercent, 60);
  // A single sample cannot bracket a window.
  assert.equal(windowCpu([samples[0] as PsSample], 0, 5), null);
});

test("combines the app's footprint with the backend and PostgreSQL samples", () => {
  const memory: MemorySample[] = [
    {
      t: 1_000,
      backend: { processes: 1, footprintMb: 100, sharedOnceMb: 100 },
      postgres: { processes: 5, footprintMb: 200, sharedOnceMb: 90 },
    },
    { t: 20_000, backend: null, postgres: null },
  ];
  const early = memoryAt(380, memory, 2_000);
  assert.equal(early.main?.footprintMb, 380);
  assert.equal(early.postgres?.sharedOnceMb, 90);
  assert.equal(early.appTotal?.footprintMb, 680);
  const late = memoryAt(410, memory, 19_000);
  assert.equal(late.appTotal?.footprintMb, 410);
  assert.deepEqual(memoryAt(null, [], 0), {});
});

test("summarizes a native run with the Electron frame statistics", () => {
  const results = nativeResults();
  const samples = [
    psSample(20_000, 100, 20, 10),
    psSample(30_000, 100.3, 20.1, 10.1),
    psSample(32_000, 100.5, 20.1, 10.1),
    psSample(42_000, 106, 20.2, 10.2),
  ];
  const summary = summarizeNativeRun({
    app: APP,
    results,
    samples,
    memory: [],
    power: (start, end) =>
      end - start === 10_000
        ? {
            samples: 10,
            cpuPowerMw: 100,
            gpuPowerMw: 50,
            anePowerMw: 0,
            combinedPowerMw: 150,
            gpuFreqMhz: 400,
            gpuActivePercent: 12,
            gpuActivePercentMax: 20,
            thermalPressure: {},
            tasks: {},
          }
        : null,
  });
  assert.equal(summary.launchToReadyMs, 2_500);
  assert.equal(summary.variant, "demo");
  const idle = summary.windows.idle;
  assert.equal(idle?.frames, null);
  assert.equal(idle?.cpu?.main?.cpuPercent, 3);
  assert.equal(idle?.inAppCpuPercent, 3);
  const scroll = summary.windows.scroll;
  assert.equal(scroll?.frames?.frames, 121);
  assert.equal(scroll?.frames?.longFrames, 1);
  assert.equal(scroll?.frames?.maxMs, 60);
  assert.equal(scroll?.hitches, 1);
  assert.equal(scroll?.cpu?.main?.cpuPercent, 55);
  assert.equal(scroll?.power?.gpuPowerMw, 50);
  assert.equal(summary.windows.pageSwitch?.settleMedianMs, 60);
  assert.equal(summary.windows.pageSwitch?.settleMaxMs, 80);
  assert.ok((summary.windows.sustained?.fpsPer10s.length ?? 0) === 0);
  assert.equal(summary.memory.afterLaunch.main?.footprintMb, 380);
  assert.equal(summary.memory.afterSustained?.main?.footprintMb, 410);
  assert.deepEqual(summary.warnings, []);
});

test("warns when the window was hidden or a switch timed out", () => {
  const results = nativeResults();
  const scroll = results.phases[1];
  const pageSwitch = results.phases[2];
  assert.ok(scroll && pageSwitch);
  scroll.windowVisibleAtEnd = false;
  pageSwitch.steps = [{ path: "/", settleMs: 15_000, timedOut: true }];
  const summary = summarizeNativeRun({
    app: APP,
    results,
    samples: [],
    memory: [],
    power: () => null,
  });
  assert.equal(summary.warnings.length, 2);
  assert.match(summary.warnings.join("\n"), /scroll: the window was hidden/);
  assert.match(summary.warnings.join("\n"), /pageSwitch: 1 page switch/);
});

function electronTier(
  tier: TierResult["tier"],
  fullEffects: boolean,
  run: number,
  idleCpu: number,
): TierResult {
  const cpu = {
    appTotal: { processes: 1, rssMb: 1, footprintMb: 1, cpuPercent: idleCpu },
  };
  const action = {
    wallMs: 1000,
    cpu,
    power: null,
    frames: { fps: 60, droppedPercent: 0, p95Ms: 17, longFrames: 0 },
    pageMetrics: {},
  };
  return {
    tier,
    fullEffects,
    run,
    effective: { tier, classes: [] },
    page: {
      innerWidth: 1,
      innerHeight: 1,
      devicePixelRatio: 2,
      screenWidth: 1,
      screenHeight: 1,
    },
    launch: { spawnToRendererReadyMs: 3000, phases: {} },
    memory: {
      afterLaunch: {
        appTotal: {
          processes: 1,
          rssMb: 1,
          footprintMb: 700,
          cpuPercent: null,
        },
      },
      afterIdle: {},
      afterSustained: null,
    },
    idle: { wallMs: 1000, cpu, power: null, seconds: 60, page: "/" },
    scroll: {
      ...action,
      method: "gesture",
      requestedPx: 1,
      reachedScrollTop: 1,
      rowsRendered: 1,
    },
    pageSwitch: {
      ...action,
      passes: [[{ path: "/", method: "link", settleMs: 100, timedOut: false }]],
    },
    trace: null,
    sustained: null,
    warnings: [],
  } as unknown as TierResult;
}

function electronResults(): BaselineResults {
  const info = { ...APP, name: "Vision Demo" };
  return {
    schemaVersion: 3,
    startedAt: "2026-10-24T10:00:00.000Z",
    finishedAt: "",
    options: {},
    machine: {},
    repoHead: null,
    powermetrics: {
      enabled: false,
      samples: 0,
      parseErrors: 0,
      keysSeen: [],
      stderr: "",
    },
    ollama: { ps: null, memory: null },
    apps: [
      {
        app: { ...info, name: "Vision" },
        originalTier: null,
        restored: true,
        tiers: [electronTier("standard", false, 1, 9)],
        error: null,
      },
      {
        app: info,
        originalTier: "standard",
        restored: true,
        tiers: [
          electronTier("enhanced", false, 1, 3),
          electronTier("standard", false, 1, 2),
          electronTier("standard", true, 1, 1.5),
        ],
        error: null,
      },
    ],
    warnings: [],
  };
}

test("picks the matching Electron edition, Full effects on, standard tier", () => {
  const picked = pickElectronReference(electronResults(), "Vision Native Demo");
  assert.equal(picked?.appName, "Vision Demo");
  assert.equal(picked?.tier.fullEffects, true);
  assert.equal(picked?.tier.idle.cpu.appTotal?.cpuPercent, 1.5);
  const empty = { ...electronResults(), apps: [] };
  assert.equal(pickElectronReference(empty, "Vision Native Demo"), null);
});

test("lists run directories newest first and skips the current one", () => {
  assert.deepEqual(
    runNamesNewestFirst(
      [
        "2026-10-24T10-00-00",
        "notes",
        "2026-10-25T09-00-00",
        "2026-10-23T08-00-00",
      ],
      "2026-10-25T09-00-00",
    ),
    ["2026-10-24T10-00-00", "2026-10-23T08-00-00"],
  );
});

test("formats deltas against Electron and handles missing numbers", () => {
  assert.equal(deltaPercent(2, 1), "-50%");
  assert.equal(deltaPercent(60, 66), "+10%");
  assert.equal(deltaPercent(0, 5), "–");
  assert.equal(deltaPercent(undefined, 5), "–");
  assert.equal(deltaPercent(5, null), "–");
});

test("renders the native section with a side-by-side table", () => {
  const summary = summarizeNativeRun({
    app: APP,
    results: nativeResults(),
    samples: [
      psSample(20_000, 100, 20, 10),
      psSample(30_000, 100.3, 20.1, 10.1),
    ],
    memory: [],
    power: () => null,
  });
  const reference = pickElectronReference(electronResults(), APP.name);
  const rows = comparisonMetrics(summary, reference?.tier ?? null);
  const idle = rows.find(
    (row) => row.label === "Idle app CPU % (all processes)",
  );
  assert.equal(idle?.electron, 1.5);
  assert.equal(idle?.native, 5);
  const text = renderNativeSection([summary], electronResults());
  assert.match(text, /^## Native app \(Swift\)/);
  assert.match(text, /Compared with Vision Demo \(standard full\)/);
  assert.match(
    text,
    /\| Idle app CPU % \(all processes\) \| 1\.5 \| 5\.0 \| \+233% \|/,
  );
  assert.match(text, /\| Scroll FPS \| 60\.0 \| 5\d\.\d \|/);
  assert.match(renderNativeSection([summary], null), /No earlier Electron run/);
  assert.match(renderNativeSection([], null), /No native app was measured/);
});

test("parseSampleReport keeps busy leaves and the app's own frames", () => {
  const report = [
    "Call graph:",
    "    2000 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)",
    "    + 1900 start  (in dyld) + 6076  [0x1]",
    "    +   1800 main  (in Vision Native Demo) + 40  [0x2]",
    "    +   ! 1200 ShellView.body.getter  (in Vision Native Demo) + 12  [0x3]",
    "    +   ! : 300 ShellView.body.getter  (in Vision Native Demo) + 80  [0x3]",
    "",
    "Total number in stack (recursive counted multiple, when >=5):",
    "",
    "Sort by top of stack, same collapsed (when >= 5):",
    "        __psynch_cvwait  (in libsystem_kernel.dylib)        900",
    "        objc_msgSend  (in libobjc.A.dylib)        120",
    "        mach_msg2_trap  (in libsystem_kernel.dylib)        800",
    "        AG::Graph::update  (in AttributeGraph)        310",
    "",
    "Binary Images:",
  ].join("\n");
  const spots = parseSampleReport(report, "Vision Native Demo");
  assert.deepEqual(spots.leaves, [
    { symbol: "AG::Graph::update", count: 310 },
    { symbol: "objc_msgSend", count: 120 },
  ]);
  assert.deepEqual(spots.appFrames, [
    { symbol: "main", count: 1800 },
    { symbol: "ShellView.body.getter", count: 1200 },
  ]);
  assert.match(
    renderHotSpots("Scroll", spots),
    /1200 {2}ShellView\.body\.getter/,
  );
});
