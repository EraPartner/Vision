import path from 'node:path';
import type { Plugin } from 'vite';

export interface BuildChunk {
    type: 'chunk';
    fileName: string;
    facadeModuleId: string | null;
    imports: string[];
    dynamicImports?: string[];
}

export interface BuildAsset {
    type: 'asset';
    fileName: string;
}

export type BuildBundle = Record<string, BuildChunk | BuildAsset>;

function isChunk(output: BuildBundle[string]): output is BuildChunk {
    return output.type === 'chunk';
}

function isAsset(output: BuildBundle[string]): output is BuildAsset {
    return output.type === 'asset';
}

function normalizedModuleId(moduleId: string | null) {
    return moduleId?.replaceAll('\\', '/') ?? null;
}

function htmlHasHref(html: string, expectedHref: string): boolean {
    return [...html.matchAll(/(?:^|[<\s])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)]
        .some((match) => (match[1] ?? match[2] ?? match[3]) === expectedHref);
}

/** Collect one chunk's complete static import closure, including the root. */
export function collectStaticChunkClosure(bundle: BuildBundle, rootFileName: string): Set<string> {
    const chunksByFile = new Map(
        Object.values(bundle).filter(isChunk).map((chunk) => [chunk.fileName, chunk]),
    );
    if (!chunksByFile.has(rootFileName)) {
        throw new Error(`Could not find build chunk ${rootFileName}`);
    }

    const closure = new Set<string>();
    const visit = (fileName: string) => {
        if (closure.has(fileName)) return;
        closure.add(fileName);
        chunksByFile.get(fileName)?.imports.forEach((dependency) => {
            if (chunksByFile.has(dependency)) visit(dependency);
        });
    };
    visit(rootFileName);
    return closure;
}

/**
 * Return the Dashboard-only static graph: everything needed by the default
 * route that the HTML entry's existing preload graph does not already fetch.
 * Dynamic imports are deliberately excluded, keeping locale and AI bundles
 * on demand.
 */
export function selectDefaultRoutePreloadFiles(
    bundle: BuildBundle,
    entryFileName: string,
    dashboardModuleId: string,
): string[] {
    const normalizedDashboardId = normalizedModuleId(dashboardModuleId);
    const dashboard = Object.values(bundle)
        .filter(isChunk)
        .find((chunk) => normalizedModuleId(chunk.facadeModuleId) === normalizedDashboardId);
    if (!dashboard) {
        throw new Error(`Could not find the Dashboard build chunk for ${dashboardModuleId}`);
    }

    const entryClosure = collectStaticChunkClosure(bundle, entryFileName);
    const dashboardClosure = collectStaticChunkClosure(bundle, dashboard.fileName);
    return [...dashboardClosure]
        .filter((fileName) => !entryClosure.has(fileName))
        .sort();
}

export function defaultRoutePreloadHrefs(
    bundle: BuildBundle,
    html: string,
    entryFileName: string,
    dashboardModuleId: string,
    base = '/',
): string[] {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return selectDefaultRoutePreloadFiles(bundle, entryFileName, dashboardModuleId)
        .map((fileName) => `${normalizedBase}${fileName}`)
        .filter((href) => !htmlHasHref(html, href));
}

const CRITICAL_FONT_ASSET_STEMS = [
    'inter-latin-400-normal',
    'fraunces-latin-600-normal',
] as const;

function withBase(base: string, fileName: string): string {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}${fileName}`;
}

/** Resolve the hashed WOFF2 assets needed for the first body and display text. */
export function criticalFontPreloadHrefs(
    bundle: BuildBundle,
    html: string,
    base = '/',
): string[] {
    const assetFileNames = Object.values(bundle)
        .filter(isAsset)
        .map((asset) => asset.fileName);

    return CRITICAL_FONT_ASSET_STEMS.map((stem) => {
        const matches = assetFileNames.filter((fileName) => {
            const basename = fileName.split('/').at(-1) ?? fileName;
            return basename === `${stem}.woff2`
                || (basename.startsWith(`${stem}-`) && basename.endsWith('.woff2'));
        });
        if (matches.length !== 1) {
            throw new Error(`Expected one ${stem} WOFF2 build asset, found ${matches.length}`);
        }
        return withBase(base, matches[0]);
    }).filter((href) => !htmlHasHref(html, href));
}

export function defaultRoutePreloadPlugin(): Plugin {
    let base = '/';
    let dashboardModuleId = '';
    return {
        name: 'vision:default-route-preload',
        apply: 'build',
        configResolved(config) {
            base = config.base;
            dashboardModuleId = path.resolve(config.root, 'src/pages/DashboardPage.tsx');
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, context) {
                if (!context.bundle || !context.chunk) {
                    throw new Error('Default-route preload requires the build bundle and HTML entry chunk');
                }
                const modulePreloads = defaultRoutePreloadHrefs(
                    context.bundle,
                    html,
                    context.chunk.fileName,
                    dashboardModuleId,
                    base,
                ).map((href) => ({
                    tag: 'link',
                    attrs: { rel: 'modulepreload', crossorigin: true, href },
                    injectTo: 'head-prepend' as const,
                }));
                const fontPreloads = criticalFontPreloadHrefs(context.bundle, html, base)
                    .map((href) => ({
                        tag: 'link',
                        attrs: {
                            rel: 'preload',
                            as: 'font',
                            type: 'font/woff2',
                            crossorigin: true,
                            href,
                        },
                        injectTo: 'head-prepend' as const,
                    }));
                return [...fontPreloads, ...modulePreloads];
            },
        },
    };
}
