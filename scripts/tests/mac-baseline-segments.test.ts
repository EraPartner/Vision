import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { parseOptions } from "../mac-baseline.ts";
import { summarizeGpuInfo } from "../lib/mac-baseline/gpuInfo.ts";
import {
  CHAT_END_MARKER,
  CHAT_MOCK_STATE,
  RESTORE_CHAT_MOCK,
  chatStreamMockExpression,
  parseSegments,
  type ChatMockState,
} from "../lib/mac-baseline/segments.ts";
import { summarizeTrace } from "../lib/mac-baseline/trace.ts";

const base = ["--app", "/nonexistent.app"];

void test("--segment is opt-in, accepts lists and rejects unknown names", () => {
  assert.deepEqual(parseOptions(base)?.segments, []);
  assert.deepEqual(
    parseOptions([
      ...base,
      "--segment",
      "chat-stream",
      "--segment",
      "window-scroll",
    ])?.segments,
    ["window-scroll", "chat-stream"],
  );
  assert.deepEqual(
    parseSegments(["window-scroll, chat-stream,window-scroll"]),
    ["window-scroll", "chat-stream"],
  );
  assert.throws(() => parseSegments(["dialog-scroll"]), /Unknown --segment/);
});

void test("--chromium-switch is repeatable and validated", () => {
  assert.deepEqual(parseOptions(base)?.chromiumSwitches, []);
  assert.deepEqual(
    parseOptions([
      ...base,
      "--chromium-switch=--disable-features=SkiaGraphite",
      "--chromium-switch=--enable-gpu-rasterization",
    ])?.chromiumSwitches,
    ["--disable-features=SkiaGraphite", "--enable-gpu-rasterization"],
  );
  assert.throws(
    () => parseOptions([...base, "--chromium-switch=disable-gpu"]),
    /takes a switch/,
  );
  assert.throws(
    () =>
      parseOptions([...base, "--chromium-switch=--remote-debugging-port=1"]),
    /remote debugging/,
  );
});

void test("the chat mock answers the AI endpoints and streams SSE tokens", async () => {
  const realFetch = globalThis.fetch;
  const passed: string[] = [];
  const stubFetch = (input: string | URL | Request) => {
    passed.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response("real"));
  };
  globalThis.fetch = stubFetch;
  Object.defineProperty(globalThis, "location", {
    value: { href: "http://app.test/", origin: "http://app.test" },
    configurable: true,
  });
  try {
    vm.runInThisContext(chatStreamMockExpression(3, 1000));
    const status = (await (
      await fetch("http://app.test/api/ai/status")
    ).json()) as {
      ok: boolean;
      data: { ok: boolean; enabled: boolean };
    };
    assert.equal(status.ok, true);
    assert.equal(status.data.ok, true);
    assert.equal(status.data.enabled, true);

    const created = (await (
      await fetch("http://app.test/api/ai/conversations", {
        method: "POST",
        body: "{}",
      })
    ).json()) as {
      data: { conversation: { id: string }; messages: unknown[] };
    };
    const id = created.data.conversation.id;
    assert.deepEqual(created.data.messages, []);

    const streamed = await (
      await fetch("http://app.test/api/ai/chat/stream", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, message: "hi" }),
      })
    ).text();
    const events = streamed
      .trim()
      .split("\n\n")
      .map((block) => /^event: (\w+)/.exec(block)?.[1]);
    assert.deepEqual(events, [
      "user_message",
      "token",
      "token",
      "token",
      "complete",
    ]);
    assert.ok(streamed.includes(JSON.stringify(`${CHAT_END_MARKER} `)));

    const detail = (await (
      await fetch(`http://app.test/api/ai/conversations/${id}`)
    ).json()) as { data: { messages: { role: string }[] } };
    assert.deepEqual(
      detail.data.messages.map((message) => message.role),
      ["user", "assistant"],
    );

    await fetch("http://app.test/api/ai/investigations");
    await fetch("http://app.test/api/transactions");
    const state = vm.runInThisContext(CHAT_MOCK_STATE) as ChatMockState;
    assert.equal(state.streams, 1);
    assert.equal(state.tokensSent, 3);
    assert.deepEqual(state.passedThrough, ["GET /api/ai/investigations"]);
    assert.deepEqual(passed, [
      "http://app.test/api/ai/investigations",
      "http://app.test/api/transactions",
    ]);

    vm.runInThisContext(RESTORE_CHAT_MOCK);
    assert.equal(globalThis.fetch, stubFetch);
  } finally {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, "location");
  }
});

void test("trace summaries attribute viz frames, render passes and raster", () => {
  const thread = (tid: number, name: string) => ({
    ph: "M",
    name: "thread_name",
    pid: 1,
    tid,
    args: { name },
  });
  const events = [
    thread(1, "VizCompositorThread"),
    thread(2, "CompositorTileWorker1"),
    thread(3, "CrGpuMain"),
    ...[0, 1].map((frame) => ({
      ph: "X",
      name: "DirectRenderer::DrawFrame",
      cat: "viz,benchmark",
      pid: 1,
      tid: 1,
      ts: 1000 + frame * 16_000,
      dur: 2000,
    })),
    ...[0, 1, 2].map((pass) => ({
      ph: "X",
      name: "DirectRenderer::DrawRenderPass",
      cat: "viz",
      pid: 1,
      tid: 1,
      ts: 1100 + pass * 100,
      dur: 50,
    })),
    {
      ph: "X",
      name: "RasterTask",
      cat: "cc",
      pid: 1,
      tid: 2,
      ts: 1200,
      dur: 3000,
    },
    {
      ph: "X",
      name: "RasterDecoderImpl::DoRasterCHROMIUM",
      cat: "gpu",
      pid: 1,
      tid: 3,
      ts: 1300,
      dur: 1000,
    },
  ];
  const { compositor } = summarizeTrace(events);
  assert.equal(compositor.drawFrames, 2);
  assert.equal(compositor.drawFrameMs, 4);
  assert.equal(compositor.renderPasses, 3);
  assert.equal(compositor.renderPassesPerFrame, 1.5);
  assert.equal(compositor.rasterTasks, 1);
  assert.equal(compositor.rasterTaskMs, 3);
  assert.equal(compositor.gpuRasterMs, 1);
  assert.deepEqual(compositor.topEvents[0], {
    name: "DirectRenderer::DrawFrame",
    count: 2,
    totalMs: 4,
  });
});

void test("GPU info keeps feature status, Skia and overlay attributes", () => {
  const info = summarizeGpuInfo({
    modelName: "MacBookAir",
    commandLine:
      "Vision --remote-debugging-port=1 --disable-features=SkiaGraphite",
    gpu: {
      devices: [
        {
          vendorString: "Apple",
          deviceString: "Apple M1",
          driverVendor: "",
          driverVersion: "",
        },
      ],
      featureStatus: {
        gpu_compositing: "enabled",
        skia_graphite: "disabled_off",
      },
      auxAttributes: {
        skiaBackendType: "GaneshMetal",
        overlayInfo: "CoreAnimation",
        glRenderer: "x",
      },
      driverBugWorkarounds: ["a"],
      videoDecoding: [{ profile: "h264" }],
    },
  });
  assert.equal(info.graphite, "disabled_off");
  assert.deepEqual(info.skia, {
    skia_graphite: "disabled_off",
    skiaBackendType: "GaneshMetal",
  });
  assert.deepEqual(info.overlay, { overlayInfo: "CoreAnimation" });
  assert.equal(info.devices[0]?.deviceString, "Apple M1");
  assert.equal(info.modelVersion, null);
  assert.ok(info.commandLine?.includes("SkiaGraphite"));
  assert.deepEqual(summarizeGpuInfo(null).featureStatus, {});
});
