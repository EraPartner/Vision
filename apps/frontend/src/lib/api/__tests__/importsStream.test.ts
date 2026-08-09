// @vitest-environment node
/**
 * Import SSE stream handling (bank + portfolio CSV imports).
 *
 * Pins the observable stream behavior: well-formed events flow to onProgress
 * and the result promise exactly as before, terminal `error` events reject
 * with the backend detail, invalid frames reject via the shared
 * 'Invalid SSE payload' path, and unknown event names are ignored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importCSVWithProgress } from '@/lib/api/imports';
import { importPortfolioCSVWithProgress } from '@/lib/api/portfolioImports';
import type { ImportProgress } from '@/lib/api/types';

/** Build a Response whose body streams `text` as a single chunk. */
function sseResponse(text: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubFetch(wire: string) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(wire)));
}

const file = new File(['a;b;c'], 'test.csv', { type: 'text/csv' });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('importCSVWithProgress SSE handling', () => {
    it('forwards well-formed progress events and resolves with the complete payload', async () => {
        const progressPayload = {
            phase: 'staging',
            current: 1,
            total: 10,
            imported: 0,
            duplicates: 0,
            errors: 0,
            percent: 4,
        };
        const completePayload = {
            total_processed: 10,
            imported: 8,
            duplicates: 2,
            errors: 0,
            batch_id: 7,
            auto_linked_count: 0,
            status: 'completed',
            percent: 100,
        };
        stubFetch(
            `event: progress\ndata: ${JSON.stringify(progressPayload)}\n\n` +
            `event: complete\ndata: ${JSON.stringify(completePayload)}\n\n`,
        );

        const onProgress = vi.fn<(p: ImportProgress) => void>();
        const { result } = importCSVWithProgress(file, 'test-bank', onProgress);

        await expect(result).resolves.toEqual(completePayload);
        expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
            progressPayload,
            { ...completePayload, phase: 'complete', percent: 100 },
        ]);
    });

    it('resolves a review_required event (backend shape: no total field) without inventing counts', async () => {
        stubFetch('event: review_required\ndata: {"batch_id":12,"match_source_counts":{"exact":1},"percent":70}\n\n');

        const onProgress = vi.fn<(p: ImportProgress) => void>();
        const { result } = importCSVWithProgress(file, 'test-bank', onProgress);

        const resolved = await result;
        expect(resolved).toEqual({
            imported: 0,
            duplicates: 0,
            errors: 0,
            status: 'review_required',
            batch_id: 12,
            requires_review: true,
        });
        // The event carries no counts, so no phantom total_processed key
        // (previously the handler read a nonexistent `total` field and set
        // total_processed: undefined).
        expect(resolved).not.toHaveProperty('total_processed');
        expect(onProgress).toHaveBeenCalledWith({
            phase: 'review_required',
            current: 0,
            total: 0,
            imported: 0,
            duplicates: 0,
            errors: 0,
            percent: 100,
        });
    });

    it('rejects with the backend detail on a terminal error event', async () => {
        stubFetch('event: error\ndata: {"detail":"Bad CSV header"}\n\n');
        const { result } = importCSVWithProgress(file, 'test-bank', vi.fn());
        await expect(result).rejects.toThrow('Bad CSV header');
    });

    it('rejects with the generic message when the error payload has no usable detail', async () => {
        stubFetch('event: error\ndata: {"detail":42}\n\n');
        const { result } = importCSVWithProgress(file, 'test-bank', vi.fn());
        await expect(result).rejects.toThrow('Import failed');
    });

    it('rejects via the Invalid SSE payload path on non-JSON frames', async () => {
        stubFetch('event: progress\ndata: not-json\n\n');
        const { result } = importCSVWithProgress(file, 'test-bank', vi.fn());
        await expect(result).rejects.toThrow('Invalid SSE payload');
    });

    it('rejects when a progress payload fails its schema instead of passing garbage to onProgress', async () => {
        stubFetch('event: progress\ndata: {"phase":"staging","current":1,"total":10,"imported":0,"duplicates":0,"errors":0,"percent":"NaN"}\n\n');
        const onProgress = vi.fn();
        const { result } = importCSVWithProgress(file, 'test-bank', onProgress);
        await expect(result).rejects.toThrow(/Invalid SSE payload for "progress" event/);
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('rejects when a complete payload is missing required counters', async () => {
        stubFetch('event: complete\ndata: {"status":"completed"}\n\n');
        const { result } = importCSVWithProgress(file, 'test-bank', vi.fn());
        await expect(result).rejects.toThrow(/Invalid SSE payload for "complete" event/);
    });

    it('rejects when a review_required payload has no numeric batch_id', async () => {
        stubFetch('event: review_required\ndata: {"batch_id":"12"}\n\n');
        const { result } = importCSVWithProgress(file, 'test-bank', vi.fn());
        await expect(result).rejects.toThrow(/Invalid SSE payload for "review_required" event/);
    });

    it('ignores unknown event names and resolves the default result on an empty stream', async () => {
        stubFetch('event: heartbeat\ndata: {"anything":true}\n\n');
        const onProgress = vi.fn();
        const { result } = importCSVWithProgress(file, 'test-bank', onProgress);
        await expect(result).resolves.toEqual({
            total_processed: 0,
            imported: 0,
            duplicates: 0,
            errors: 0,
            status: 'completed',
        });
        expect(onProgress).not.toHaveBeenCalled();
    });
});

describe('importPortfolioCSVWithProgress SSE handling', () => {
    const config = {} as never;

    it('forwards well-formed progress events and resolves with the complete payload', async () => {
        const progressPayload = {
            phase: 'committing',
            current: 5,
            total: 5,
            imported: 5,
            duplicates: 0,
            errors: 0,
            percent: 100,
        };
        const completePayload = {
            batch_id: 3,
            total_processed: 5,
            skipped: 0,
            imported: 5,
            duplicates: 0,
            errors: 0,
            status: 'completed',
            percent: 100,
        };
        stubFetch(
            `event: progress\ndata: ${JSON.stringify(progressPayload)}\n\n` +
            `event: complete\ndata: ${JSON.stringify(completePayload)}\n\n`,
        );

        const onProgress = vi.fn<(p: ImportProgress) => void>();
        const { result } = importPortfolioCSVWithProgress(file, config, 'generic', onProgress);

        await expect(result).resolves.toEqual(completePayload);
        expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
            progressPayload,
            { ...completePayload, phase: 'complete', percent: 100 },
        ]);
    });

    it('resolves a review_required event exactly as before', async () => {
        stubFetch('event: review_required\ndata: {"batch_id":9,"match_source_counts":{},"percent":70}\n\n');
        const onProgress = vi.fn<(p: ImportProgress) => void>();
        const { result } = importPortfolioCSVWithProgress(file, config, 'generic', onProgress);
        await expect(result).resolves.toEqual({
            batch_id: 9,
            imported: 0,
            duplicates: 0,
            errors: 0,
            status: 'review_required',
            requires_review: true,
        });
        expect(onProgress).toHaveBeenCalledWith({
            phase: 'review_required',
            current: 0,
            total: 0,
            imported: 0,
            duplicates: 0,
            errors: 0,
            percent: 70,
        });
    });

    it('rejects with the backend detail on a terminal error event', async () => {
        stubFetch('event: error\ndata: {"detail":"Unknown adapter"}\n\n');
        const { result } = importPortfolioCSVWithProgress(file, config, 'generic', vi.fn());
        await expect(result).rejects.toThrow('Unknown adapter');
    });

    it('rejects when a complete payload fails its schema', async () => {
        stubFetch('event: complete\ndata: {"batch_id":"nope","imported":1,"duplicates":0,"errors":0}\n\n');
        const { result } = importPortfolioCSVWithProgress(file, config, 'generic', vi.fn());
        await expect(result).rejects.toThrow(/Invalid SSE payload for "complete" event/);
    });
});
