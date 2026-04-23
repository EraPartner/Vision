import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { drainIfNeeded, createSseWriter } from '../src/lib/sse.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes({ needDrain = false } = {}) {
  const emitter = new EventEmitter();
  const written = [];
  return {
    _written: written,
    writableNeedDrain: needDrain,
    writableEnded: false,
    write: vi.fn((chunk) => { written.push(chunk); return !needDrain; }),
    end: vi.fn(() => { emitter.writableEnded = true; }),
    once: (event, cb) => emitter.once(event, cb),
    emit: (event) => emitter.emit(event),
  };
}

function makeReq() {
  const emitter = new EventEmitter();
  return {
    on: (event, cb) => emitter.on(event, cb),
    emit: (event) => emitter.emit(event),
  };
}

// ─── drainIfNeeded ────────────────────────────────────────────────────────────

describe('drainIfNeeded', () => {
  it('resolves immediately when buffer is not full', async () => {
    const res = makeRes({ needDrain: false });
    await expect(drainIfNeeded(res)).resolves.toBeUndefined();
  });

  it('waits for drain event when buffer is full', async () => {
    const res = makeRes({ needDrain: true });
    let resolved = false;

    const p = drainIfNeeded(res).then(() => { resolved = true; });
    expect(resolved).toBe(false);

    res.emit('drain');
    await p;
    expect(resolved).toBe(true);
  });
});

// ─── createSseWriter ──────────────────────────────────────────────────────────

describe('createSseWriter', () => {
  let req;
  let res;
  let writer;

  beforeEach(() => {
    req = makeReq();
    res = makeRes();
    writer = createSseWriter(req, res);
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

  it('becomes closed when req emits close', () => {
    req.emit('close');
    expect(writer.closed).toBe(true);
  });

  it('no-ops write() after client disconnect', async () => {
    req.emit('close');
    await writer.write('token', 'ignored');
    expect(res.write).not.toHaveBeenCalled();
  });

  it('end() calls res.end()', () => {
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
    const drainWriter = createSseWriter(makeReq(), drainRes);

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
