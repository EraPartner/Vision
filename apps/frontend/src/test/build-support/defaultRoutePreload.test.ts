import { describe, expect, it } from 'vitest';

// The production guard is an executable ESM script, so it has no TypeScript declaration file.
// @ts-expect-error -- importing its exported pure URL resolver is intentional for this contract test.
import { bundleOutputPathFromHref } from '../../../scripts/check-bundle-size.mjs';
import {
    type BuildBundle,
    type BuildAsset,
    type BuildChunk,
    criticalFontPreloadHrefs,
    defaultRoutePreloadHrefs,
    selectDefaultRoutePreloadFiles,
} from '../../build-support/defaultRoutePreload';

const DASHBOARD_ID = '/repo/apps/frontend/src/pages/DashboardPage.tsx';

function chunk(overrides: Omit<BuildChunk, 'type'>): BuildChunk {
    return {
        type: 'chunk',
        ...overrides,
    };
}

function asset(fileName: string): BuildAsset {
    return { type: 'asset', fileName };
}

function fixtureBundle(): BuildBundle {
    const outputs = [
        chunk({ fileName: 'assets/index-random.js', facadeModuleId: '/repo/src/main.tsx', imports: ['assets/react-shared.js'] }),
        chunk({
            fileName: 'assets/route-random.js',
            facadeModuleId: DASHBOARD_ID,
            imports: ['assets/charts-random.js', 'assets/react-shared.js', 'assets/card-random.js'],
            dynamicImports: ['assets/locale-random.js', 'assets/ai-random.js'],
        }),
        chunk({ fileName: 'assets/charts-random.js', facadeModuleId: null, imports: ['assets/chart-helper-random.js'] }),
        chunk({ fileName: 'assets/chart-helper-random.js', facadeModuleId: null, imports: ['assets/charts-random.js'] }),
        chunk({ fileName: 'assets/card-random.js', facadeModuleId: null, imports: [] }),
        chunk({ fileName: 'assets/react-shared.js', facadeModuleId: null, imports: [] }),
        chunk({ fileName: 'assets/locale-random.js', facadeModuleId: '/repo/src/locales/en.ts', imports: [] }),
        chunk({ fileName: 'assets/ai-random.js', facadeModuleId: '/repo/src/pages/AIChatPage.tsx', imports: [] }),
        asset('assets/inter-latin-400-normal-interhash.woff2'),
        asset('assets/fraunces-latin-600-normal-fraunceshash.woff2'),
        asset('assets/inter-latin-400-normal-legacyhash.woff'),
        asset('assets/inter-latin-600-normal-noncritical.woff2'),
    ];
    return Object.fromEntries(outputs.map((output) => [output.fileName, output]));
}

describe('default route modulepreloads', () => {
    it('selects the complete route-only static closure once in stable order', () => {
        expect(selectDefaultRoutePreloadFiles(fixtureBundle(), 'assets/index-random.js', DASHBOARD_ID)).toEqual([
            'assets/card-random.js',
            'assets/chart-helper-random.js',
            'assets/charts-random.js',
            'assets/route-random.js',
        ]);
    });

    it('respects the deployment base and omits links already in the HTML', () => {
        const html = '<link rel="modulepreload" href="/vision/assets/card-random.js">';
        expect(defaultRoutePreloadHrefs(
            fixtureBundle(),
            html,
            'assets/index-random.js',
            DASHBOARD_ID,
            '/vision/',
        )).toEqual([
            '/vision/assets/chart-helper-random.js',
            '/vision/assets/charts-random.js',
            '/vision/assets/route-random.js',
        ]);
        expect(defaultRoutePreloadHrefs(
            fixtureBundle(),
            '',
            'assets/index-random.js',
            DASHBOARD_ID,
            './',
        )[0]).toBe('./assets/card-random.js');
    });

    it('fails loudly when the entry or Dashboard chunk is missing', () => {
        expect(() => selectDefaultRoutePreloadFiles(fixtureBundle(), 'assets/missing-entry.js', DASHBOARD_ID))
            .toThrow(/missing-entry/);
        expect(() => selectDefaultRoutePreloadFiles(
            fixtureBundle(),
            'assets/index-random.js',
            '/missing/DashboardPage.tsx',
        )).toThrow(/Dashboard build chunk/);
    });
});

describe('critical font preloads', () => {
    it('selects only Inter 400 and Fraunces 600 WOFF2 assets in paint order', () => {
        expect(criticalFontPreloadHrefs(fixtureBundle(), '')).toEqual([
            '/assets/inter-latin-400-normal-interhash.woff2',
            '/assets/fraunces-latin-600-normal-fraunceshash.woff2',
        ]);
        expect(criticalFontPreloadHrefs(fixtureBundle(), '', '/vision/')).toEqual([
            '/vision/assets/inter-latin-400-normal-interhash.woff2',
            '/vision/assets/fraunces-latin-600-normal-fraunceshash.woff2',
        ]);
    });

    it('respects relative bases and omits links already in the HTML', () => {
        const html = "<link rel='preload' href='./assets/inter-latin-400-normal-interhash.woff2'>";
        expect(criticalFontPreloadHrefs(fixtureBundle(), html, './')).toEqual([
            './assets/fraunces-latin-600-normal-fraunceshash.woff2',
        ]);
    });

    it('does not mistake similarly named attributes for href', () => {
        const interHref = '/assets/inter-latin-400-normal-interhash.woff2';
        const html = `<div data-href="${interHref}" xlink:href="${interHref}"></div>`;
        expect(criticalFontPreloadHrefs(fixtureBundle(), html)).toEqual([
            interHref,
            '/assets/fraunces-latin-600-normal-fraunceshash.woff2',
        ]);
    });

    it('fails loudly when a critical font asset is missing or ambiguous', () => {
        const missing = fixtureBundle();
        delete missing['assets/fraunces-latin-600-normal-fraunceshash.woff2'];
        expect(() => criticalFontPreloadHrefs(missing, '')).toThrow(/Fraunces|fraunces/i);

        const ambiguous = fixtureBundle();
        ambiguous['assets/inter-latin-400-normal-secondhash.woff2'] =
            asset('assets/inter-latin-400-normal-secondhash.woff2');
        expect(() => criticalFontPreloadHrefs(ambiguous, '')).toThrow(/found 2/);
    });
});

describe('bundle-size public URL resolution', () => {
    it.each([
        ['/assets/app.js', 'assets/app.js'],
        ['./assets/app.js', 'assets/app.js'],
        ['/vision/assets/app.js', 'assets/app.js'],
        ['https://cdn.example.com/vision/assets/app.js', 'assets/app.js'],
        ['https://cdn.example.com/assets/vision/assets/app.js', 'assets/app.js'],
    ])('maps %s to its Vite output path', (href, expected) => {
        expect(bundleOutputPathFromHref(href)).toBe(expected);
    });

    it('rejects URLs outside the Vite assets directory', () => {
        expect(() => bundleOutputPathFromHref('/vision/index.html')).toThrow(/assets directory/);
    });
});
