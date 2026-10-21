import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindowConstructorOptions, PrintToPDFOptions } from "electron";
import {
  REPORT_PRINT_CSP,
  REPORT_PRINT_PARTITION,
  REPORT_PRINT_SCHEME,
  createReportPdfPrinter,
  type ReportPrintSession,
  type ReportPrintWindow,
} from "./report-pdf";

const HTML = "<!DOCTYPE html><html><body>Report</body></html>";

function fakeSession() {
  const state: {
    handler?: (request: Request) => Response | Promise<Response>;
    scheme?: string;
    beforeRequest?: (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void;
    permissionRequest?: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    permissionCheck?: () => boolean;
    configured: number;
  } = { configured: 0 };
  const session: ReportPrintSession = {
    protocol: {
      handle(scheme, handler) {
        state.configured++;
        state.scheme = scheme;
        state.handler = handler;
      },
    },
    webRequest: {
      onBeforeRequest(listener) {
        state.beforeRequest = listener;
      },
    },
    setPermissionRequestHandler(handler) {
      state.permissionRequest = handler;
    },
    setPermissionCheckHandler(handler) {
      state.permissionCheck = handler;
    },
  };
  return { session, state };
}

interface FakeWindow extends ReportPrintWindow {
  options: BrowserWindowConstructorOptions;
  loaded: string[];
  served: string[];
  printOptions: PrintToPDFOptions[];
  destroyed: boolean;
}

function fakeWindowFactory(
  state: ReturnType<typeof fakeSession>["state"],
  print: (window: FakeWindow) => Promise<Uint8Array> = async () =>
    new Uint8Array([37, 80, 68, 70]),
) {
  const windows: FakeWindow[] = [];
  const createWindow = (options: BrowserWindowConstructorOptions) => {
    const window: FakeWindow = {
      options,
      loaded: [],
      served: [],
      printOptions: [],
      destroyed: false,
      webContents: {
        async loadURL(url) {
          window.loaded.push(url);
          const response = await state.handler!(new Request(url));
          window.served.push(await response.text());
        },
        printToPDF(printOptions) {
          window.printOptions.push(printOptions);
          return print(window);
        },
        setWindowOpenHandler() {},
        on() {},
      },
      isDestroyed: () => window.destroyed,
      destroy() {
        window.destroyed = true;
      },
    };
    windows.push(window);
    return window;
  };
  return { windows, createWindow };
}

test("prints in a hidden, script-free, sandboxed window on the dedicated session", async () => {
  const { session, state } = fakeSession();
  const { windows, createWindow } = fakeWindowFactory(state);
  const printer = createReportPdfPrinter({ session: () => session, createWindow });

  const pdf = await printer.print({ html: HTML, footerTemplate: "<div>f</div>" });

  assert.deepEqual([...pdf], [37, 80, 68, 70]);
  const [window] = windows;
  assert.ok(window);
  assert.equal(window.options.show, false);
  assert.deepEqual(
    {
      partition: window.options.webPreferences?.partition,
      sandbox: window.options.webPreferences?.sandbox,
      contextIsolation: window.options.webPreferences?.contextIsolation,
      nodeIntegration: window.options.webPreferences?.nodeIntegration,
      javascript: window.options.webPreferences?.javascript,
      preload: window.options.webPreferences?.preload,
    },
    {
      partition: REPORT_PRINT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      preload: undefined,
    },
  );
  assert.match(window.loaded[0] ?? "", new RegExp(`^${REPORT_PRINT_SCHEME}://`));
  assert.deepEqual(window.served, [HTML]);
  assert.equal(window.printOptions[0]?.pageSize, "A4");
  assert.equal(window.printOptions[0]?.printBackground, true);
  assert.equal(window.printOptions[0]?.footerTemplate, "<div>f</div>");
  assert.equal(window.printOptions[0]?.displayHeaderFooter, true);
  assert.equal(window.destroyed, true);
});

test("the print session serves only live documents, denies permissions and blocks the network", async () => {
  const { session, state } = fakeSession();
  const { windows, createWindow } = fakeWindowFactory(state);
  const printer = createReportPdfPrinter({ session: () => session, createWindow });
  await printer.print({ html: HTML, footerTemplate: "" });
  await printer.print({ html: HTML, footerTemplate: "" });

  assert.equal(state.configured, 1, "the scheme is registered once");
  const documentUrl = windows[0]!.loaded[0]!;
  const stale = await state.handler!(new Request(documentUrl));
  assert.equal(stale.status, 404, "a printed document is no longer served");

  const live = createReportPdfPrinter({
    session: () => session,
    createWindow: fakeWindowFactory(state, async (window) => {
      const response = await state.handler!(new Request(window.loaded[0]!));
      assert.equal(
        response.headers.get("Content-Security-Policy"),
        REPORT_PRINT_CSP,
      );
      return new Uint8Array();
    }).createWindow,
  });
  await live.print({ html: HTML, footerTemplate: "" });

  const decisions: boolean[] = [];
  for (const url of [
    "https://example.com/beacon.png",
    "http://127.0.0.1:3002/api/transactions",
    "file:///etc/hosts",
    `${REPORT_PRINT_SCHEME}://report/x`,
  ]) {
    state.beforeRequest!({ url }, ({ cancel }) => decisions.push(cancel));
  }
  assert.deepEqual(decisions, [true, true, true, false]);

  let granted: boolean | undefined;
  state.permissionRequest!(undefined, "media", (value) => {
    granted = value;
  });
  assert.equal(granted, false);
  assert.equal(state.permissionCheck!(), false);
});

test("a failed or hung print destroys its window and does not block the next report", async () => {
  const { session, state } = fakeSession();
  let call = 0;
  const { windows, createWindow } = fakeWindowFactory(state, async () => {
    call++;
    if (call === 1) throw new Error("print failed");
    if (call === 2) return new Promise<Uint8Array>(() => {});
    return new Uint8Array([1]);
  });
  const printer = createReportPdfPrinter({
    session: () => session,
    createWindow,
    timeoutMs: 20,
  });

  const results = await Promise.allSettled([
    printer.print({ html: HTML, footerTemplate: "" }),
    printer.print({ html: HTML, footerTemplate: "" }),
    printer.print({ html: HTML, footerTemplate: "" }),
  ]);

  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.match(
    String((results[1] as PromiseRejectedResult).reason),
    /timed out/,
  );
  assert.deepEqual(results[2], { status: "fulfilled", value: new Uint8Array([1]) });
  assert.deepEqual(
    windows.map((window) => window.destroyed),
    [true, true, true],
  );
});
