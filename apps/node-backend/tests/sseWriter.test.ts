import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { __drainIfNeeded as drainIfNeeded, createSseWriter } from '../src/lib/sse.ts';
import type { SseWriter } from '../src/lib/sse.ts';
import { loose } from './helpers/partial.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes({ needDrain = false } = {}) {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const res = {
    _written: written,
    writableNeedDrain: needDrain,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { written.push(chunk); return !needDrain; }),
    end: vi.fn(() => { res.writableEnded = true; }),
    once: (event: string, cb: () => void) => emitter.once(event, cb),
    on: (event: string, cb: () => void) => emitter.on(event, cb),
    emit: (event: string) => emitter.emit(event),
  };
  return res;
}

function makeReq() {
  const emitter = new EventEmitter();
  return {
    on: (event: string, cb: () => void) => emitter.on(event, cb),
    emit: (event: string) => emitter.emit(event),
  };
}

type FakeRes = ReturnType<typeof makeRes>;
type FakeReq = ReturnType<typeof makeReq>;

// The fakes carry only the stream members sse.ts touches.
const asRes = (res: FakeRes) => loose<ServerResponse>(res);
const asReq = (req: FakeReq) => loose<IncomingMessage>(req);

// ─── drainIfNeeded ────────────────────────────────────────────────────────────

describe('drainIfNeeded', () => {
  it('resolves immediately when buffer is not full', async () => {
    const res = makeRes({ needDrain: false });
    await expect(drainIfNeeded(asRes(res))).resolves.toBeUndefined();
  });

  it('waits for drain event when buffer is full', async () => {
    const res = makeRes({ needDrain: true });
    let resolved = false;

    const p = drainIfNeeded(asRes(res)).then(() => { resolved = true; });
    expect(resolved).toBe(false);

    res.emit('drain');
    await p;
    expect(resolved).toBe(true);
  });
});

// ─── createSseWriter ──────────────────────────────────────────────────────────

describe('createSseWriter', () => {
  let req: FakeReq;
  let res: FakeRes;
  let writer: SseWriter;

  beforeEach(() => {
    req = makeReq();
    res = makeRes();
    writer = createSseWriter(asReq(req), asRes(res));
    // Reset write mock so the constructor's flush-padding comment is not
    // counted in subsequent assertions.
    res.write.mockClear();
    res._written.length = 0;
  });

  it('commits the SSE response headers on construction', () => {
    const headerRes = makeRes();
    createSseWriter(asReq(makeReq()), asRes(headerRes));
    expect(headerRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
  });

  it('writes a leading flush-padding comment on construction', () => {
    const padReq = makeReq();
    const padRes = makeRes();
    createSseWriter(asReq(padReq), asRes(padRes));
    expect(padRes._written.length).toBeGreaterThan(0);
    const first = padRes._written[0];
    expect(first.startsWith(':')).toBe(true);
    expect(first.length).toBeGreaterThanOrEqual(2048);
  });

  it('writes correctly formatted SSE frame', async () => {
    await writer.write('token', 'hello');
    expect(res.write).toHaveBeenCalledWith('event: token\ndata: "hello"\n\n');
  });

  it('serialises objects as JSON in data field', async () => {
    await writer.write('done', { ok: true, count: 3 });
    expect(res.write).toHaveBeenCalledWith(
      'event: done\ndata: {"ok":true,"count":3}\n\n',
    );
  });

  it('starts as not closed', () => {
    expect(writer.closed).toBe(false);
  });

  it('becomes closed when res emits close', () => {
    res.emit('close');
    expect(writer.closed).toBe(true);
  });

  it('no-ops write() after client disconnect', async () => {
    res.emit('close');
    await writer.write('token', 'ignored');
    expect(res.write).not.toHaveBeenCalled();
  });

  it('end() calls res.end()', () => {
    writer.end();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('end() ends the response only once when called twice', () => {
    writer.end();
    writer.end();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('end() is idempotent when already ended', () => {
    res.writableEnded = true;
    writer.end();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('awaits drain when buffer is full', async () => {
    const drainRes = makeRes({ needDrain: true });
    const drainWriter = createSseWriter(asReq(makeReq()), asRes(drainRes));

    let resolved = false;
    const p = drainWriter.write('token', 'x').then(() => { resolved = true; });

    expect(resolved).toBe(false);
    drainRes.emit('drain');
    await p;
    expect(resolved).toBe(true);
  });

  it('multiple writes are ordered', async () => {
    await writer.write('a', 1);
    await writer.write('b', 2);
    await writer.write('c', 3);

    expect(res._written).toEqual([
      'event: a\ndata: 1\n\n',
      'event: b\ndata: 2\n\n',
      'event: c\ndata: 3\n\n',
    ]);
  });
});
