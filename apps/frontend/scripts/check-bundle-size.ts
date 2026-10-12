#!/usr/bin/env bun
/**
 * Bundle-size regression guard.
 *
 * Runs after `vite build` and fails the build if either of two gzip totals
 * exceeds a checked-in budget:
 *
 *   1. BOOT-PRELOAD graph — the entry chunk (`<script type="module">` in
 *      dist/index.html) plus every chunk the page `<link rel="modulepreload">`s
 *      up front. This is what the browser must fetch+parse before the app can
 *      render its first route, regardless of which route that is.
 *   2. TOTAL — every JS/CSS asset gzip-summed, i.e. the whole app (all routes,
 *      including lazy ones).
 *
 * Why this exists: the team already shipped one silent regression where
 * recharts (a dependency of exactly one component, reachable only through the
 * lazy-loaded AIChatPage) leaked into the initial preload graph via a shared
 * module and added ~114 kB gz to every cold load. See the `manualChunks`
 * comment in vite.config.ts and the flash-prevention comment in index.html for
 * the post-mortem. Nothing short of measuring the
 * actual preload graph on every build would have caught that before users did.
 *
 * We parse dist/index.html directly rather than the Vite/Rollup manifest
 * because this project does not enable `build.manifest` — index.html already
 * lists the exact entry + modulepreload set the browser will request, which is
 * the thing we actually care about guarding.
 *
 * Usage:
 *   bun run build && bun scripts/check-bundle-size.ts
 *   VISION_DIST_DIR=/tmp/vision-dist bun scripts/check-bundle-size.ts
 *   (wired up as the `size:check` package.json script; CI runs it right
 *   after `bun run build`)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
const FRONTEND_ROOT = path.resolve(import.meta.dirname, '..');
// vite.config.ts sets build.outDir to "../../dist" (relative to apps/frontend).
const DIST_DIR = process.env.VISION_DIST_DIR
    ? path.resolve(process.env.VISION_DIST_DIR)
    : path.resolve(FRONTEND_ROOT, '../../dist');

/**
 * Budgets, in gzip KB (1024 bytes). Bump these ONLY as a deliberate,
 * one-line, reviewed change when a real feature legitimately grows the
 * bundle — never silently, never as a drive-by in an unrelated PR.
 *
 * Convention (matches the vitest coverage-threshold comment in
 * vite.config.ts): budget = measured KB, rounded up, plus ~5% headroom to
 * absorb routine dependency-lockfile churn without false alarms — tight
 * enough that a single mis-scoped import still trips it.
 *
 * Last measured (2026-10-06, production build with the current locked dependencies):
 *   boot-preload graph: 440.67 KB gz (49 files: entry + 48 modulepreloads)
 *   total (all routes): 1117.21 KB gz (164 JS/CSS assets)
 * The 2026-09-24 revision measured 445.33 KB / 1046.60 KB (163 assets). Since
 * then locales, the analysis workbench, the lazy xlsx reader and portfolio
 * import grew the total, all in lazy route or locale chunks; the owner approved
 * the higher total budget in #212. The preload budget is unchanged.
 * The 2026-08-25 budget revision, built with the same local toolchain, measured
 * 399.96 KB / 914.30 KB. The intervening analysis, AI, category, planning,
 * and audit features account for the larger route set. Keep the new budgets
 * close to the current measured graph rather than exempting these features.
 *
 * The 2026-08-02 drop (306.76 -> 282.14 KB gz, -24.62) is the Framer Motion
 * engine leaving the entry chunk: every `motion.*` call site now uses the
 * tree-shaken `m` API under one <LazyMotion> provider (App.tsx) whose features
 * are fetched asynchronously from src/lib/motionFeatureBundle.ts. That chunk
 * (27.67 KB gz) must never appear in the list above — if it does, something
 * imported `motion`, `domMax` or the bundle module from non-lazy code and the
 * split has been defeated. Total went UP 2.40 KB because the engine is now its
 * own chunk instead of being inlined; that is the intended trade.
 */
const BUDGETS_KB = {
    // 445.33 * 1.05 = 467.60, rounded up after measured feature growth.
    // Raised from 468 for the Belgian-tax household store wiring (ADR-200,
    // phase B2): 467.53 -> 469.33 measured. The household engine itself loads
    // lazily (householdRuntime); only the store and provider glue are boot code.
    // Raised from 470 for the reduction for pensions (arts 147-153) and the gift
    // ceiling in the shared personPit chunk that computeBelgianPIT keeps in the
    // boot graph: 470.52 measured.
    preload: 471,
    // 1310.71 measured after the lazily loaded xlsx chunk arrived with the
    // IBKR funding import (2026-10-08); raised from 1180 (was 1100 before that).
    // Raised from 1340 for the lazily loaded Belgian-tax household engine, its
    // settings schemas and the household issue locale strings (ADR-200, phase
    // B2): 1334.97 -> 1348.31 measured. Raised from 1349 for the phase B2
    // review fixes (household engine in the trend strip and yearly chart,
    // upgrade validation, unreadable-household and engine-load-failure
    // states with their EN/NL strings): 1348.16 -> 1349.02 measured.
    // Raised from 1351 for the household editor steps, the per-partner breakdown card and
    // their EN/NL strings (ADR-200, phase C1, tax route chunks): 1349.02 -> 1357.48 measured.
    // Raised from 1359 for the partner attribution of recorded figures, the per-partner
    // export rows and the readable household history with their EN/NL strings (ADR-201,
    // phase C2, tax and export route chunks; boot preload unchanged): 1357.48 -> 1360.47
    // measured.
    // Raised from 1362 for the reduction for pensions, joint gifts, the per-borrower
    // own-home baskets and their EN/NL strings: 1364.10 measured.
    // Raised from 1365 for the pension type of box V, the art. 147 exclusion of activity
    // income and their EN/NL strings (ADR-203): 1365.61 measured.
    total: 1366,
};

/** Parses dist/index.html for the entry module script and its modulepreload set. */
function getBootPreloadFiles(html: string): string[] {
    const entryMatch = html.match(
        /<script[^>]+type="module"[^>]+src="([^"]+)"/,
    );
    if (!entryMatch) {
        throw new Error(
            'Could not find the entry <script type="module"> tag in dist/index.html — has the build output format changed?',
        );
    }

    const preloadRe = /<link rel="modulepreload"[^>]+href="([^"]+)"/g;
    const preloads: string[] = [];
    for (const match of html.matchAll(preloadRe)) {
        if (match[1] !== undefined) preloads.push(match[1]);
    }

    // De-duplicate defensively; each entry is a root-relative URL (e.g. "/assets/foo.js").
    const entry = entryMatch[1];
    if (entry === undefined) {
        throw new Error('The entry <script type="module"> tag in dist/index.html has no src.');
    }
    return [...new Set([entry, ...preloads])];
}

/** Map a public asset URL back to its path inside the Vite output directory. */
export function bundleOutputPathFromHref(href: string): string {
    const pathname = new URL(href, 'https://vision.invalid/').pathname;
    const assetsMarker = '/assets/';
    const markerIndex = pathname.lastIndexOf(assetsMarker);
    if (markerIndex === -1) {
        throw new Error(`Bundle URL does not point into the Vite assets directory: ${href}`);
    }
    return pathname.slice(markerIndex + 1);
}

/** Recursively lists every .js/.css file under dist/, relative to dist/. */
function listAllBundleFiles(dir: string, base: string = dir): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listAllBundleFiles(full, base));
        } else if (/\.(js|css)$/.test(entry)) {
            out.push(path.relative(base, full));
        }
    }
    return out;
}

function gzipSizeOf(distRelativePath: string): number {
    const absPath = path.join(DIST_DIR, bundleOutputPathFromHref(distRelativePath));
    const buf = readFileSync(absPath);
    return gzipSync(buf, { level: 9 }).length;
}

function formatKB(bytes: number): string {
    return (bytes / 1024).toFixed(2);
}

function main(): void {
    const indexHtmlPath = path.join(DIST_DIR, 'index.html');
    let html: string;
    try {
        html = readFileSync(indexHtmlPath, 'utf8');
    } catch {
        console.error(
            `size:check could not read ${indexHtmlPath} — run the build first (bun run build).`,
        );
        process.exit(1);
    }

    const preloadFiles = getBootPreloadFiles(html);
    const preloadRows = preloadFiles
        .map((f) => ({ file: path.basename(f), gzip: gzipSizeOf(f) }))
        .sort((a, b) => b.gzip - a.gzip);
    const preloadTotalBytes = preloadRows.reduce((sum, r) => sum + r.gzip, 0);

    const allFiles = listAllBundleFiles(path.join(DIST_DIR, 'assets')).map(
        (f) => path.posix.join('assets', f.split(path.sep).join('/')),
    );
    const totalBytes = allFiles.reduce((sum, f) => sum + gzipSizeOf(f), 0);

    console.log('Boot-preload graph (entry chunk + modulepreloads):');
    for (const row of preloadRows) {
        console.log(`  ${row.file.padEnd(36)} ${formatKB(row.gzip).padStart(8)} KB gz`);
    }
    console.log(
        `  ${'TOTAL'.padEnd(36)} ${formatKB(preloadTotalBytes).padStart(8)} KB gz  (budget: ${BUDGETS_KB.preload} KB)`,
    );
    console.log('');
    console.log(
        `All bundle assets (${allFiles.length} files): ${formatKB(totalBytes)} KB gz  (budget: ${BUDGETS_KB.total} KB)`,
    );
    console.log('');

    const failures: string[] = [];
    const preloadKB = preloadTotalBytes / 1024;
    if (preloadKB > BUDGETS_KB.preload) {
        failures.push(
            `Boot-preload graph is ${preloadKB.toFixed(2)} KB gz, over budget of ${BUDGETS_KB.preload} KB gz (+${(preloadKB - BUDGETS_KB.preload).toFixed(2)} KB).\n` +
                `  Something is now reachable from the entry chunk (or one of its eager imports) that wasn't before.\n` +
                `  Check whether a lazy-route-only dependency (e.g. a chart library) got imported from non-lazy code —\n` +
                `  see the manualChunks comment in vite.config.ts for the recharts precedent.\n` +
                `  If this growth is legitimate, bump BUDGETS_KB.preload in scripts/check-bundle-size.ts with a one-line\n` +
                `  comment explaining why, after re-measuring.`,
        );
    }
    const totalKB = totalBytes / 1024;
    if (totalKB > BUDGETS_KB.total) {
        failures.push(
            `Total bundle size is ${totalKB.toFixed(2)} KB gz, over budget of ${BUDGETS_KB.total} KB gz (+${(totalKB - BUDGETS_KB.total).toFixed(2)} KB).\n` +
                `  If this growth is legitimate, bump BUDGETS_KB.total in scripts/check-bundle-size.ts with a one-line\n` +
                `  comment explaining why, after re-measuring.`,
        );
    }

    if (failures.length > 0) {
        console.error('BUNDLE SIZE REGRESSION:\n');
        console.error(failures.join('\n\n'));
        process.exit(1);
    }

    console.log('size:check passed — bundle within budget.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    main();
}
