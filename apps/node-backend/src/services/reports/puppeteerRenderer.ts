/**
 * Singleton Puppeteer browser for HTML→PDF rendering.
 *
 * One browser process is shared across all report requests to avoid the cost
 * of launching Chromium per request. Each render opens a new page and closes
 * it on completion. Call closeBrowser() on process shutdown.
 */

import type { Browser, PDFOptions } from "puppeteer";
import { logger } from "../../config/logger.ts";

/** Options for {@link renderHtmlToPdf}. */
export interface RenderPdfOptions {
  footerTemplate?: string;
  headerTemplate?: string;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
}

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const { default: puppeteer } = await import("puppeteer");
  // The native macOS runtime points this at a supported installed
  // Chrome/Chromium executable so packaged PDF
  // rendering does not depend on a Puppeteer download cache.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const launched = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  browser = launched;
  logger.info("Puppeteer browser launched for report rendering");
  return launched;
}

// Bound concurrent renders so N simultaneous report POSTs can't open N Chromium
// pages (+ N full data fetches) at once. Each render still runs to completion;
// excess renders queue for a slot rather than piling pages onto one browser.
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    renderWaiters.push(() => resolve());
  });
}

function releaseRenderSlot(): void {
  const next = renderWaiters.shift();
  if (next) {
    // Hand the still-held slot straight to the next waiter (no decrement).
    next();
  } else {
    activeRenders -= 1;
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;

  // Memoize the in-flight launch: two concurrent first renders otherwise both
  // launched Chromium, the second assignment overwrote `browser`, and the first
  // process leaked. The promise clears on settle so a failed launch can retry.
  if (!launchPromise) {
    launchPromise = launchBrowser().finally(() => {
      launchPromise = null;
    });
  }
  return launchPromise;
}

/**
 * Render an HTML string to a PDF buffer (A4 portrait, print backgrounds).
 *
 * @param html - Full HTML document string.
 */
export async function renderHtmlToPdf(
  html: string,
  opts: RenderPdfOptions = {},
): Promise<Buffer> {
  await acquireRenderSlot();
  try {
    return await renderHtmlToPdfInner(html, opts);
  } finally {
    releaseRenderSlot();
  }
}

async function renderHtmlToPdfInner(
  html: string,
  opts: RenderPdfOptions = {},
): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pdfOpts: PDFOptions = {
      format: "A4",
      printBackground: true,
      margin: opts.margin ?? { top: "0", right: "0", bottom: "0", left: "0" },
    };

    if (opts.footerTemplate || opts.headerTemplate) {
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate = opts.headerTemplate ?? "<span></span>";
      pdfOpts.footerTemplate = opts.footerTemplate ?? "<span></span>";
    }

    const pdf = await page.pdf(pdfOpts);
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

/**
 * Gracefully close the browser. Call on SIGINT / SIGTERM.
 */
export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // ignore errors during shutdown
  } finally {
    browser = null;
    launchPromise = null;
  }
}
