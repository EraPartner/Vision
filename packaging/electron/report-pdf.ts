// Report PDF printing with Electron's own Chromium (ADR-234).
//
// The backend builds a self-contained report document; the renderer hands it
// over IPC and this module prints it in a hidden window that has no preload,
// no JavaScript, no permissions and no network. The document is served from
// memory through a scheme registered only on a dedicated in-memory session, so
// it never touches disk and never shares the application session.

import crypto from "node:crypto";
import type {
  BrowserWindowConstructorOptions,
  HandlerDetails,
  PrintToPDFOptions,
  WindowOpenHandlerResponse,
} from "electron";
import type { ReportPrintRequest } from "./electron-api";

export const REPORT_PRINT_PARTITION = "vision-report-print";
export const REPORT_PRINT_SCHEME = "vision-report";
// Report HTML is inline-styled and script-free; nothing else may load.
export const REPORT_PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const REPORT_PRINT_TIMEOUT_MS = 60_000;
// The report CSS reserves a 28px footer band in @page (backend reports/index.ts).
const FOOTER_HEIGHT_INCHES = 28 / 96;
const DOCUMENT_ID_RE = /\/([0-9a-f-]{36})$/;

export interface ReportPrintSession {
  protocol: {
    handle(
      scheme: string,
      handler: (request: Request) => Response | Promise<Response>,
    ): void;
  };
  webRequest: {
    onBeforeRequest(
      listener: (
        details: { url: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

export interface ReportPrintWindow {
  webContents: {
    loadURL(url: string): Promise<void>;
    printToPDF(options: PrintToPDFOptions): Promise<Uint8Array>;
    setWindowOpenHandler(
      handler: (details: HandlerDetails) => WindowOpenHandlerResponse,
    ): void;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }) => void,
    ): unknown;
  };
  isDestroyed(): boolean;
  destroy(): void;
}

export interface ReportPdfPrinterDependencies {
  /** The dedicated, non-persistent session for REPORT_PRINT_PARTITION. */
  session: () => ReportPrintSession;
  createWindow: (options: BrowserWindowConstructorOptions) => ReportPrintWindow;
  timeoutMs?: number;
  randomId?: () => string;
}

export function reportPrintWindowOptions(): BrowserWindowConstructorOptions {
  return {
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      partition: REPORT_PRINT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  };
}

export function reportPdfOptions(footerTemplate: string): PrintToPDFOptions {
  return {
    pageSize: "A4",
    printBackground: true,
    preferCSSPageSize: false,
    margins: { top: 0, right: 0, bottom: FOOTER_HEIGHT_INCHES, left: 0 },
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate,
  };
}

export function createReportPdfPrinter({
  session,
  createWindow,
  timeoutMs = REPORT_PRINT_TIMEOUT_MS,
  randomId = () => crypto.randomUUID(),
}: ReportPdfPrinterDependencies) {
  const documents = new Map<string, string>();
  let configured = false;
  let queue: Promise<unknown> = Promise.resolve();

  function configureSession(): void {
    if (configured) return;
    const printSession = session();
    printSession.setPermissionRequestHandler((_contents, _permission, done) =>
      done(false),
    );
    printSession.setPermissionCheckHandler(() => false);
    printSession.webRequest.onBeforeRequest((details, done) =>
      done({ cancel: !details.url.startsWith(`${REPORT_PRINT_SCHEME}:`) }),
    );
    printSession.protocol.handle(REPORT_PRINT_SCHEME, (request) => {
      const id = DOCUMENT_ID_RE.exec(request.url)?.[1];
      const html = id === undefined ? undefined : documents.get(id);
      if (html === undefined) return new Response(null, { status: 404 });
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": REPORT_PRINT_CSP,
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
    configured = true;
  }

  async function printOnce({
    html,
    footerTemplate,
  }: ReportPrintRequest): Promise<Uint8Array> {
    configureSession();
    const id = randomId();
    documents.set(id, html);
    const win = createWindow(reportPrintWindowOptions());
    let timer: NodeJS.Timeout | undefined;
    try {
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      const printed = (async () => {
        await win.webContents.loadURL(`${REPORT_PRINT_SCHEME}://report/${id}`);
        return win.webContents.printToPDF(reportPdfOptions(footerTemplate));
      })();
      // A late failure after a timeout must not surface as an unhandled rejection.
      printed.catch(() => undefined);
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Report printing timed out")),
          timeoutMs,
        );
      });
      return await Promise.race([printed, timedOut]);
    } finally {
      clearTimeout(timer);
      documents.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  return {
    /** Print one report; concurrent calls run one at a time. */
    print(request: ReportPrintRequest): Promise<Uint8Array> {
      const run = queue.then(() => printOnce(request));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
