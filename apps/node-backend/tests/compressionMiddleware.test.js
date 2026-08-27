import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:zlib', () => ({ createGzip: vi.fn() }));

import { createGzip } from 'node:zlib';
import { compression } from '../src/middleware/compression.js';

function createGzipDouble({ writeResult = true } = {}) {
  const gzip = new EventEmitter();
  gzip.write = vi.fn(() => writeResult);
  gzip.end = vi.fn(() => queueMicrotask(() => gzip.emit('end')));
  gzip.pause = vi.fn();
  gzip.resume = vi.fn();
  return gzip;
}

function createResponse({ headers = {}, headersSent = false, writeResult = true } = {}) {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const response = new EventEmitter();
  response.headersSent = headersSent;
  response.setHeader = vi.fn((name, value) => values.set(name.toLowerCase(), value));
  response.getHeader = vi.fn((name) => values.get(name.toLowerCase()));
  response.removeHeader = vi.fn((name) => values.delete(name.toLowerCase()));
  response.write = vi.fn(() => writeResult);
  response.end = vi.fn(() => response);
  response.destroy = vi.fn();
  return response;
}

function runMiddleware(options = {}) {
  const acceptEncoding = Object.hasOwn(options, 'acceptEncoding') ? options.acceptEncoding : 'gzip';
  const res = options.response ?? createResponse();
  const originalWrite = res.write;
  const originalEnd = res.end;
  const next = vi.fn();
  const headers = {};
  if (acceptEncoding !== undefined) headers['accept-encoding'] = acceptEncoding;
  compression({ headers }, res, next);
  return { res, next, originalWrite, originalEnd };
}

describe('compression', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['missing', undefined],
    ['br string', 'br'],
    ['array without exact gzip', ['br, gzip']],
  ])('does not wrap a response when gzip support is %s', (_label, acceptEncoding) => {
    const response = createResponse({ headers: { 'Content-Type': 'application/json' } });
    const { res, next, originalWrite, originalEnd } = runMiddleware({ acceptEncoding, response });
    expect(res.write).toBe(originalWrite);
    expect(res.end).toBe(originalEnd);
    res.end('body');
    expect(originalEnd).toHaveBeenCalledWith('body');
    expect(next).toHaveBeenCalledOnce();
    expect(createGzip).not.toHaveBeenCalled();
    expect(res.getHeader('Content-Encoding')).toBeUndefined();
  });

  it('preserves exact-element array semantics for Accept-Encoding', () => {
    const gzip = createGzipDouble();
    createGzip.mockReturnValue(gzip);
    const response = createResponse({ headers: { 'Content-Type': 'application/json' } });
    const { res } = runMiddleware({ acceptEncoding: ['br', 'gzip'], response });
    res.end('body');
    expect(createGzip).toHaveBeenCalledOnce();
  });

  it.each([
    ['headers already sent', { headersSent: true, headers: { 'Content-Type': 'application/json' } }],
    ['server-sent events', { headers: { 'Content-Type': 'text/event-stream' } }],
    ['proxy buffering disabled', { headers: { 'Content-Type': 'application/json', 'X-Accel-Buffering': 'NO' } }],
    ['non-compressible content', { headers: { 'Content-Type': 'image/png' } }],
    ['known small response', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1023' } }],
  ])('defers setup and preserves the original end path for %s', async (_label, options) => {
    const response = createResponse(options);
    const { res, next, originalEnd } = runMiddleware({ response });
    const callback = vi.fn();

    expect(next).toHaveBeenCalledOnce();
    res.end('body', 'utf8', callback);

    expect(createGzip).not.toHaveBeenCalled();
    expect(originalEnd).toHaveBeenCalledWith('body', 'utf8', callback);
  });

  it.each([
    [undefined, 'Accept-Encoding'],
    ['Origin', 'Origin, Accept-Encoding'],
    ['Origin, accept-encoding', 'Origin, accept-encoding'],
  ])('compresses eligible output and merges Vary %#', async (vary, expectedVary) => {
    const gzip = createGzipDouble();
    createGzip.mockReturnValue(gzip);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': '2048' };
    if (vary !== undefined) headers.Vary = vary;
    const response = createResponse({ headers });
    const { res, originalWrite, originalEnd } = runMiddleware({ response });
    const callback = vi.fn();

    expect(res.write('first')).toBe(true);
    expect(createGzip).toHaveBeenCalledOnce();
    expect(gzip.write).toHaveBeenCalledWith('first', undefined, undefined);
    expect(res.getHeader('Content-Encoding')).toBe('gzip');
    expect(res.getHeader('Vary')).toBe(expectedVary);
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Length');

    gzip.emit('data', Buffer.from('compressed'));
    expect(originalWrite).toHaveBeenCalledWith(Buffer.from('compressed'));

    expect(res.end('last', callback)).toBe(res);
    expect(gzip.write).toHaveBeenCalledWith('last', undefined);
    await Promise.resolve();
    expect(originalEnd).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('preserves downstream and upstream backpressure and destroys on gzip errors', () => {
    const gzip = createGzipDouble();
    createGzip.mockReturnValue(gzip);
    const response = createResponse({ headers: { 'Content-Type': 'application/json' }, writeResult: false });
    const { res } = runMiddleware({ response });
    const responseDrain = vi.fn();
    res.on('drain', responseDrain);
    res.write('body');

    gzip.emit('data', Buffer.from('compressed'));
    expect(gzip.pause).toHaveBeenCalledOnce();
    expect(gzip.resume).not.toHaveBeenCalled();
    res.emit('drain');
    expect(gzip.resume).toHaveBeenCalledOnce();

    gzip.emit('drain');
    expect(responseDrain).toHaveBeenCalledTimes(2);

    const error = new Error('gzip failed');
    gzip.emit('error', error);
    expect(res.destroy).toHaveBeenCalledWith(error);
  });
});
