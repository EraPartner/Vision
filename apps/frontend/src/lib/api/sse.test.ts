import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseSseFrame, readSseStream, type SseEvent } from './sse';

function makeResponse(chunks: string[], { abortAfter }: { abortAfter?: number } = {}): Response {
    const encoder = new TextEncoder();
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (emitted >= chunks.length) {
                controller.close();
                return;
            }
            if (abortAfter !== undefined && emitted >= abortAfter) {
                controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                return;
            }
            controller.enqueue(encoder.encode(chunks[emitted]));
            emitted += 1;
        },
    });
    return new Response(body, { status: 200 });
}

async function collect<T>(gen: AsyncGenerator<SseEvent<T>>): Promise<SseEvent<T>[]> {
    const out: SseEvent<T>[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

describe('parseSseFrame', () => {
    it('returns undefined for comment-only frames', () => {
        expect(parseSseFrame(': keep-alive')).toBeUndefined();
    });

    it('defaults event name to "message" when absent', () => {
        expect(parseSseFrame('data: {"x":1}')).toEqual({ eventName: 'message', dataRaw: '{"x":1}' });
    });

    it('respects explicit event name', () => {
        expect(parseSseFrame('event: progress\ndata: {"percent":10}')).toEqual({
            eventName: 'progress',
            dataRaw: '{"percent":10}',
        });
    });

    it('joins multi-line data with newlines', () => {
        expect(parseSseFrame('data: line1\ndata: line2')).toEqual({
            eventName: 'message',
            dataRaw: 'line1\nline2',
        });
    });
});

describe('readSseStream', () => {
    it('parses discrete events delivered in a single chunk', async () => {
        const response = makeResponse([
            'event: progress\ndata: {"n":1}\n\nevent: complete\ndata: {"done":true}\n\n',
        ]);
        const events = await collect(readSseStream<{ n?: number; done?: boolean }>(response));
        expect(events).toEqual([
            { event: 'progress', data: { n: 1 } },
            { event: 'complete', data: { done: true } },
        ]);
    });

    it('reassembles events split across chunk boundaries', async () => {
        const response = makeResponse([
            'event: progress\ndata: {"n":',
            '1}\n\nevent: progress\ndata: {"n":2}',
            '\n\n',
        ]);
        const events = await collect(readSseStream<{ n: number }>(response));
        expect(events.map((e) => e.data.n)).toEqual([1, 2]);
    });

    it('skips keep-alive comments and [DONE] sentinel', async () => {
        const response = makeResponse([
            ': ping\n\n',
            'data: {"v":1}\n\n',
            'data: [DONE]\n\n',
        ]);
        const events = await collect(readSseStream<{ v: number }>(response));
        expect(events).toEqual([{ event: 'message', data: { v: 1 } }]);
    });

    it('throws on invalid JSON payload', async () => {
        const response = makeResponse(['data: not-json\n\n']);
        await expect(collect(readSseStream(response))).rejects.toThrow('Invalid SSE payload');
    });

    it('throws when response has no body', async () => {
        const response = new Response(null, { status: 204 });
        await expect(collect(readSseStream(response))).rejects.toThrow('No response body');
    });

    it('surfaces AbortError from the underlying reader', async () => {
        const response = makeResponse(['data: {"v":1}\n\n', 'data: {"v":2}\n\n'], { abortAfter: 1 });
        const iter = readSseStream<{ v: number }>(response);
        const first = await iter.next();
        expect(first.value).toEqual({ event: 'message', data: { v: 1 } });
        await expect(iter.next()).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('emits trailing event without terminating blank line', async () => {
        const response = makeResponse(['data: {"v":42}']);
        const events = await collect(readSseStream<{ v: number }>(response));
        expect(events).toEqual([{ event: 'message', data: { v: 42 } }]);
    });

    it('handles \\r\\n line endings', async () => {
        const response = makeResponse(['event: progress\r\ndata: {"n":7}\r\n\r\n']);
        const events = await collect(readSseStream<{ n: number }>(response));
        expect(events).toEqual([{ event: 'progress', data: { n: 7 } }]);
    });
});

describe('readSseStream per-event schemas', () => {
    const schemas = { progress: z.looseObject({ n: z.number() }) };

    it('passes payloads that satisfy the schema through unchanged (unknown keys kept)', async () => {
        const response = makeResponse(['event: progress\ndata: {"n":1,"extra":"x"}\n\n']);
        const events = await collect(readSseStream(response, { schemas }));
        expect(events).toEqual([{ event: 'progress', data: { n: 1, extra: 'x' } }]);
    });

    it('rejects via the Invalid SSE payload path when a schema fails', async () => {
        const response = makeResponse(['event: progress\ndata: {"n":"NaN"}\n\n']);
        await expect(collect(readSseStream(response, { schemas }))).rejects.toThrow(
            /Invalid SSE payload for "progress" event/,
        );
    });

    it('leaves events without a schema entry unvalidated (unknown events tolerated)', async () => {
        const response = makeResponse(['event: mystery\ndata: {"whatever":true}\n\n']);
        const events = await collect(readSseStream(response, { schemas }));
        expect(events).toEqual([{ event: 'mystery', data: { whatever: true } }]);
    });

    it('does not treat inherited object properties as schemas', async () => {
        const response = makeResponse(['event: constructor\ndata: {"v":1}\n\n']);
        const events = await collect(readSseStream(response, { schemas }));
        expect(events).toEqual([{ event: 'constructor', data: { v: 1 } }]);
    });
});
