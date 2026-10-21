---
title: "ADR-234: Print report PDFs with Electron's own Chromium"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, electron, reports, pdf, packaging, native-runtime, security, adr-155, adr-208]
description: "The backend returns a print-ready report document instead of PDF bytes, and the Electron main process prints it with webContents.printToPDF in a hidden, sandboxed, script-free window without network access. Puppeteer, the bundled Chrome Headless Shell, its payload preparation, release step and PUPPETEER_* handling are removed. A plain browser opens its print dialog instead. Supersedes the PDF-browser part of ADR-155."
aliases: [adr-234, electron report printing, remove puppeteer, remove chrome headless shell]
related_code:
  [
    "packaging/electron/report-pdf.ts",
    "packaging/electron/main.ts",
    "packaging/electron/preload.ts",
    "packaging/electron/electron-api.d.ts",
    "packaging/electron/runtime/ipc-schemas.ts",
    "apps/node-backend/src/services/reports/index.ts",
    "apps/node-backend/src/routes/reports.ts",
    "apps/frontend/src/lib/api/reports.ts",
    "packages/types/src/contracts/reports.ts",
  ]
---

# ADR-234: Print report PDFs with Electron's own Chromium

## Status

Accepted. Supersedes the "PDF browser" item of
[[docs/adr/155-evidence-led-electron-surface|ADR-155]]'s bundle-asset decision.

## Date

2026-10-20

## Context

Report PDFs were rendered by the backend through Puppeteer, which drove a separately bundled,
pinned Chrome Headless Shell. The packaging scripts installed that browser with Puppeteer's
installer, copied and verified it into the native runtime payload and manifest, and the runtime
resolved it into `PUPPETEER_EXECUTABLE_PATH`. Startup refused to run without it. Vision is a
single-user macOS Electron app, so a second Chromium duplicated the one Electron already ships,
added a large payload to hash and sign, and kept a browser process with `--no-sandbox` inside the
backend.

The report HTML is self-contained: inline styles, inline SVG charts, system fonts and no scripts.
It needs no JavaScript and no network to print.

## Decision

- `POST /api/reports/{financial,portfolio,tax}` keep their request bodies and validation and now
  return the success envelope with a `ReportDocument`: `filename`, the complete `html` document and
  the Chromium `footerTemplate`. The backend builds documents only. Report admission
  ([[docs/adr/208-bounded-report-pipeline|ADR-208]]) still bounds data fetching and HTML
  creation.
- The renderer hands the document to the main process through one new invoke channel,
  `report:print-pdf` (`window.electronReports.printToPdf`). Only the application document may call
  it. Its argument contract accepts a document starting with `<!DOCTYPE html>` of at most 32 MiB
  characters and a footer of at most 16 KiB.
- `packaging/electron/report-pdf.ts` prints in a hidden `BrowserWindow` with `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, no preload and `javascript: false`, on the
  non-persistent `vision-report-print` partition. The document is served from memory through a
  scheme registered only on that session with `default-src 'none'; style-src 'unsafe-inline';
  img-src data:; font-src data:`. All other requests on the session are cancelled; permission
  requests and checks are denied; window creation and in-page navigation are denied. The window
  calls `webContents.printToPDF` (A4, printed backgrounds, a 28px bottom margin with the footer
  template) and is destroyed afterwards. Prints run one at a time with a 60-second timeout. The
  renderer downloads the bytes as before.
- In a plain browser (no Electron bridge, for example the backend opened directly in a browser),
  the frontend prints the document from a hidden `srcdoc` frame through the browser print dialog.
  That path has no page-number footer and no success toast.
- Remove `puppeteer` from the backend, `puppeteerRenderer.ts` with its render slot,
  `PUPPETEER_EXECUTABLE_PATH`, the Chrome discovery and startup check in the native runtime,
  `prepare-chromium-runtime.ts`, the chromium step of the native and development payload
  preparers, the `prepare:chromium` script, the installer and release-workflow browser
  installation, and their tests.

This keeps the HTTP routes and request shape, adds no listening socket or token, and keeps the
security-sensitive part in the main process, which already owns the window, sessions and IPC
validation. A loopback callback from the backend to Electron was rejected: it would add a
second authenticated local endpoint for the same result.

## Consequences

- Breaking API change: clients that expected `application/pdf` bytes must print the returned
  document. The shipped frontend, OpenAPI contract, generated types and endpoint matrix are
  updated. The operation count is unchanged.
- The native payload and its manifest no longer contain `chromium/`; the packaged app should
  shrink by the size of Chrome Headless Shell. This was not measured here.
- PDF output depends on Electron's Chromium version instead of a separately pinned one. Layout
  uses the same `@page`, margin and footer template contract as before; Mac verification is
  required on each Electron upgrade.
- A report can no longer be produced without the desktop shell except through a browser's print
  dialog.
- The Electron invoke contract grows by one channel.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/155-evidence-led-electron-surface|ADR-155]]
- [[docs/adr/208-bounded-report-pipeline|ADR-208]]
- [[docs/api/reports|Reports API]]
- [[docs/features/pdf-report-export|PDF Report Export]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
