/**
 * Vitest reporter that makes omitted live-backend contract tests explicit.
 *
 * The live-contract suite self-skips when LIVE_API_BASE is absent. A normal
 * local run should stay fast and green, but its summary must not look
 * equivalent to CI's full-stack contract run.
 */

const LIVE_CONTRACT_MODULE = '/src/test/live-contracts/live-contracts.test.ts';
const SEPARATOR = '='.repeat(78);

interface TestModuleLike {
    moduleId: string;
    children?: {
        allTests(state: 'skipped'): Iterable<unknown>;
    };
}

interface LiveContractSkipCounts {
    skippedTests: number;
    skippedFiles: number;
}

function isLiveContractModule(moduleId: string): boolean {
    return moduleId.replaceAll('\\', '/').endsWith(LIVE_CONTRACT_MODULE);
}

export function collectLiveContractSkips(testModules: Iterable<TestModuleLike> | undefined): LiveContractSkipCounts {
    let skippedTests = 0;
    let skippedFiles = 0;

    for (const testModule of testModules ?? []) {
        if (!isLiveContractModule(testModule.moduleId)) continue;

        let moduleSkipped = 0;
        try {
            for (const _test of testModule.children?.allTests('skipped') ?? []) moduleSkipped += 1;
        } catch {
            moduleSkipped = 0;
        }
        if (moduleSkipped === 0) continue;

        skippedTests += moduleSkipped;
        skippedFiles += 1;
    }

    return { skippedTests, skippedFiles };
}

export function formatLiveContractSkipBanner(
    { skippedTests, skippedFiles }: LiveContractSkipCounts,
    color = false,
): string {
    const bold = color ? '\u001B[1;31m' : '';
    const dim = color ? '\u001B[31m' : '';
    const reset = color ? '\u001B[0m' : '';
    const tests = skippedTests === 1 ? 'test' : 'tests';
    const files = skippedFiles === 1 ? 'file' : 'files';

    return [
        '',
        `${bold}${SEPARATOR}${reset}`,
        `${bold}  INCOMPLETE RUN -- ${skippedTests} live-contract ${tests} across ${skippedFiles} ${files} were SKIPPED${reset}`,
        `${bold}${SEPARATOR}${reset}`,
        `${dim}  LIVE_API_BASE is not set, so the real-backend API contract suite${reset}`,
        `${dim}  self-skipped. This run is NOT equivalent to CI's full-stack${reset}`,
        `${dim}  "Test (Live API Contracts)" job.${reset}`,
        '',
        `${bold}  Run the live-contract suite against the Vision Demo or another${reset}`,
        `${bold}  disposable backend before trusting API-contract changes.${reset}`,
        `${bold}${SEPARATOR}${reset}`,
        '',
    ].join('\n');
}

interface ReporterOptions {
    env?: Record<string, string | undefined>;
    write?: (text: string) => void;
    color?: boolean;
}

export function createLiveContractSkipBannerReporter(options: ReporterOptions = {}) {
    const env = options.env ?? process.env;
    const write = options.write ?? ((text: string) => process.stdout.write(text));
    const color = options.color
        ?? (!env.NO_COLOR && (Boolean(env.FORCE_COLOR) || Boolean(process.stdout.isTTY)));

    return {
        isLiveContractSkipBanner: true,
        onTestRunEnd(testModules: Iterable<TestModuleLike>) {
            if (env.LIVE_API_BASE) return;
            const counts = collectLiveContractSkips(testModules);
            if (counts.skippedTests === 0) return;
            write(formatLiveContractSkipBanner(counts, color));
        },
    };
}
