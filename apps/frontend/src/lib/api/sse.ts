/**
 * Shared Server-Sent Events (SSE) stream reader.
 *
 * Parses a `ReadableStream<Uint8Array>` response body as SSE per
 * https://html.spec.whatwg.org/multipage/server-sent-events.html and yields
 * one typed event per `event:`/`data:` block.
 *
 * Partial chunk reassembly: chunks are decoded with `stream: true` and split
 * on the spec-compliant blank-line separator (`\r?\n\r?\n`); trailing bytes
 * are preserved across reads. Lines beginning with `:` are treated as
 * comments / keep-alive and skipped. Frames whose data payload is the
 * sentinel `[DONE]` are also skipped so callers never see it.
 *
 * Abort handling is the caller's responsibility: pass an `AbortSignal` to
 * the `fetch` that produced `response`. When aborted, the underlying reader
 * rejects and the generator surfaces the `AbortError`.
 */

import { z } from 'zod';

/** One parsed SSE event. `event` defaults to "message" when not specified. */
export interface SseEvent<T> {
    event: string;
    data: T;
}

const FRAME_SEPARATOR = /\r?\n\r?\n/;
const DATA_PREFIX = 'data:';
const EVENT_PREFIX = 'event:';
const DONE_SENTINEL = '[DONE]';
const DEFAULT_EVENT_NAME = 'message';

export interface ParsedFrame {
    eventName: string;
    dataRaw: string;
}

/**
 * Optional runtime validation for `readSseStream`, keyed by event name.
 * Events with an entry must satisfy their schema or the stream fails via the
 * same `Invalid SSE payload` error path as malformed JSON; events without an
 * entry pass through unvalidated, so unknown event names stay tolerated.
 */
export interface SseStreamOptions {
    schemas?: Record<string, z.ZodType>;
}

/**
 * Parse a single SSE frame (text between blank-line separators) into an
 * event name and raw data payload. Returns `undefined` when the frame is a
 * comment/keep-alive with no data lines.
 */
export function parseSseFrame(block: string): ParsedFrame | undefined {
    let eventName = DEFAULT_EVENT_NAME;
    const dataLines: string[] = [];

    for (const rawLine of block.split(/\r?\n/)) {
        if (!rawLine || rawLine.startsWith(':')) continue;
        if (rawLine.startsWith(EVENT_PREFIX)) {
            const parsedName = rawLine.slice(EVENT_PREFIX.length).trim();
            eventName = parsedName || DEFAULT_EVENT_NAME;
            continue;
        }
        if (rawLine.startsWith(DATA_PREFIX)) {
            dataLines.push(rawLine.slice(DATA_PREFIX.length).trimStart());
        }
    }

    if (dataLines.length === 0) return undefined;
    return { eventName, dataRaw: dataLines.join('\n') };
}

/**
 * Read an SSE response body and yield each parsed frame (event name + raw
 * data payload) as it arrives. Comment/keep-alive frames are skipped;
 * `[DONE]` sentinel frames are NOT filtered at this layer.
 *
 * Throws `Error('No response body')` if the response has no readable body,
 * or whatever the underlying reader rejects with (e.g. `AbortError`).
 */
export async function* readSseFrames(response: Response): AsyncGenerator<ParsedFrame, void, void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let separatorMatch = buffer.match(FRAME_SEPARATOR);
            while (separatorMatch) {
                const separatorIndex = separatorMatch.index ?? -1;
                if (separatorIndex < 0) break;

                const block = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + separatorMatch[0].length);

                const frame = parseSseFrame(block);
                if (frame) yield frame;

                separatorMatch = buffer.match(FRAME_SEPARATOR);
            }
        }

        const trailing = decoder.decode();
        if (trailing) buffer += trailing;
        if (buffer.trim()) {
            const frame = parseSseFrame(buffer.trimEnd());
            if (frame) yield frame;
        }
    } finally {
        // Release the lock so callers can abort/cancel cleanly.
        try {
            reader.releaseLock();
        } catch {
            // Reader may already be released on abort; ignore.
        }
    }
}

/**
 * Read an SSE response body and yield each event as it arrives.
 *
 * Throws:
 *  - `Error('No response body')` if the response has no readable body.
 *  - `Error('Invalid SSE payload')` if a `data:` payload is not valid JSON,
 *    or does not satisfy the caller-provided schema for its event name.
 *  - Whatever the underlying reader rejects with (e.g. `AbortError`).
 *
 * `[DONE]` sentinel frames and keep-alive comment frames are filtered out.
 */
export async function* readSseStream<T>(
    response: Response,
    options: SseStreamOptions = {},
): AsyncGenerator<SseEvent<T>, void, void> {
    for await (const frame of readSseFrames(response)) {
        const event = toEvent<T>(frame, options.schemas);
        if (event) yield event;
    }
}

function toEvent<T>(frame: ParsedFrame, schemas?: Record<string, z.ZodType>): SseEvent<T> | undefined {
    if (frame.dataRaw === DONE_SENTINEL) return undefined;

    let data: unknown;
    try {
        data = JSON.parse(frame.dataRaw);
    } catch {
        throw new Error('Invalid SSE payload');
    }

    // Own-property lookup so inherited names (e.g. "constructor") never
    // resolve to a bogus schema.
    const schema = schemas && Object.hasOwn(schemas, frame.eventName)
        ? schemas[frame.eventName]
        : undefined;
    if (schema) {
        const result = schema.safeParse(data);
        if (!result.success) {
            const issues = result.error.issues
                .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                .join('; ');
            throw new Error(`Invalid SSE payload for "${frame.eventName}" event: ${issues}`);
        }
        data = result.data;
    }

    return { event: frame.eventName, data: data as T };
}
