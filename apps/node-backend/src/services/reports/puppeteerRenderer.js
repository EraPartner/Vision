/**
 * Singleton Puppeteer browser for HTML→PDF rendering.
 *
 * One browser process is shared across all report requests to avoid the cost
 * of launching Chromium per request. Each render opens a new page and closes
 * it on completion. Call closeBrowser() on process shutdown.
 */

import { logger } from '../../config/logger.js';

/** @type {import('puppeteer').Browser | null} */
let browser = null;
/** @type {Promise<import('puppeteer').Browser> | null} */
let launchPromise = null;

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  // In Docker (Alpine) PUPPETEER_EXECUTABLE_PATH points to the distro-packaged
  // Chromium (musl-linked, works on ARM64). Locally it is unset and Puppeteer
  // falls back to its own bundled Chrome.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const launched = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  browser = launched;
  logger.info('Puppeteer browser launched for report rendering');
  return launched;
}

async function getBrowser() {
  if (browser?.connected) return browser;

  // Memoize the in-flight launch: two concurrent first renders otherwise both
  // launched Chromium, the second assignment overwrote `browser`, and the first
  // process leaked. The promise clears on settle so a failed launch can retry.
  if (!launchPromise) {
    launchPromise = launchBrowser().finally(() => { launchPromise = null; });
  }
  return launchPromise;
}

/**
 * Render an HTML string to a PDF buffer (A4 portrait, print backgrounds).
 *
 * @param {string} html - Full HTML document string.
 * @param {{
 *   footerTemplate?: string;
 *   headerTemplate?: string;
 *   margin?: { top?: string; right?: string; bottom?: string; left?: string };
 * }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function renderHtmlToPdf(html, opts = {}) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    /** @type {import('puppeteer').PDFOptions} */
    const pdfOpts = {
      format: 'A4',
      printBackground: true,
      margin: opts.margin ?? { top: '0', right: '0', bottom: '0', left: '0' },
    };

    if (opts.footerTemplate || opts.headerTemplate) {
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate = opts.headerTemplate ?? '<span></span>';
      pdfOpts.footerTemplate = opts.footerTemplate ?? '<span></span>';
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
export async function closeBrowser() {
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
