import { describe, expect, it } from 'vitest';
import {
    collectLiveContractSkips,
    createLiveContractSkipBannerReporter,
    formatLiveContractSkipBanner,
} from './liveContractSkipBanner';

function fakeModule(moduleId: string, skipped = 0) {
    return {
        moduleId,
        children: {
            *allTests(state: 'skipped') {
                if (state !== 'skipped') return;
                for (let index = 0; index < skipped; index += 1) yield { name: `${moduleId}#${index}` };
            },
        },
    };
}

const liveModule = '/repo/apps/frontend/src/test/live-contracts/live-contracts.test.ts';

describe('collectLiveContractSkips', () => {
    it('counts only skipped cases in the live-contract module', () => {
        expect(collectLiveContractSkips([
            fakeModule(liveModule, 36),
            fakeModule('/repo/apps/frontend/src/example.test.ts', 4),
        ])).toEqual({ skippedTests: 36, skippedFiles: 1 });
    });

    it('survives a matching module whose children cannot be walked', () => {
        expect(collectLiveContractSkips([{ moduleId: liveModule }])).toEqual({
            skippedTests: 0,
            skippedFiles: 0,
        });
    });
});

describe('formatLiveContractSkipBanner', () => {
    it('states the measured counts, missing environment, and full-stack distinction', () => {
        const text = formatLiveContractSkipBanner({ skippedTests: 36, skippedFiles: 1 });
        expect(text).toContain('36 live-contract tests across 1 file were SKIPPED');
        expect(text).toContain('LIVE_API_BASE is not set');
        expect(text).toContain('Test (Live API Contracts)');
    });
});

describe('createLiveContractSkipBannerReporter', () => {
    function capture(env: Record<string, string | undefined>, modules = [fakeModule(liveModule, 36)]) {
        const written: string[] = [];
        const reporter = createLiveContractSkipBannerReporter({
            env,
            write: (text) => written.push(text),
            color: false,
        });
        reporter.onTestRunEnd(modules);
        return written.join('');
    }

    it('fires when LIVE_API_BASE is unset and live contracts skipped', () => {
        expect(capture({})).toContain('INCOMPLETE RUN -- 36 live-contract tests');
    });

    it('stays silent when LIVE_API_BASE is set', () => {
        expect(capture({ LIVE_API_BASE: 'http://localhost:3002' })).toBe('');
    });

    it('stays silent when only unrelated tests skipped', () => {
        expect(capture({}, [fakeModule('/repo/apps/frontend/src/example.test.ts', 3)])).toBe('');
    });
});
