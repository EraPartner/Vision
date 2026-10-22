/**
 * In-repo HTTP test agent (ADR-245; replaces `supertest`).
 *
 * Keeps supertest's chainable API and the superagent behaviour the suite
 * relies on, so route tests read the same:
 *
 *   const res = await httpAgent(app).post('/api/x').send({ a: 1 }).expect(201);
 *
 * Each request starts the app on an ephemeral 127.0.0.1 port, sends one
 * request through node:http, closes the server and runs the `.expect()`
 * assertions in order. Like supertest: redirects are not followed, 4xx/5xx
 * are not errors by themselves, `.send(object)` defaults to JSON,
 * `.send(string)` defaults to form encoding, `.query(object)` repeats array
 * keys (`a=1&a=2`) and writes null as a bare key, and responses are parsed as
 * JSON (`application/json`, `+json`), Buffer (image/audio/video/font,
 * octet-stream, pdf, gzip) or text (`body` stays `{}`).
 */
import { deepStrictEqual } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders, RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import zlib from 'node:zlib';

export interface Response {
  status: number;
  statusCode: number;
  ok: boolean;
  clientError: boolean;
  serverError: boolean;
  /** Parsed body: JSON value, Buffer for binary types, otherwise `{}`. Typed `unknown`; narrow per assertion. */
  body: unknown;
  /** Raw text for text and JSON types; undefined for binary types and HEAD. */
  text: string;
  /** Content type without parameters. */
  type: string;
  charset?: string | undefined;
  headers: IncomingHttpHeaders;
  header: IncomingHttpHeaders;
  links: Record<string, string>;
  get(field: string): string | string[] | undefined;
}

export type CallbackHandler = (err: unknown, res: Response) => void;

export interface AttachOptions {
  filename?: string;
  contentType?: string;
}

type Assertion = (res: Response) => Error | undefined;
type Part =
  | { name: string; value: string }
  | { name: string; file: Buffer; filename: string; contentType: string };

const BINARY_TYPES = new Set(['application/octet-stream', 'application/pdf']);

function isJson(mime: string): boolean {
  return /[/+]json($|[^-\w])/i.test(mime);
}

function isBinary(mime: string): boolean {
  const [registry = '', name = ''] = mime.toLowerCase().split('/');
  return (
    ['audio', 'font', 'image', 'video'].includes(registry.trim()) ||
    ['gz', 'gzip'].includes(name.trim()) ||
    BINARY_TYPES.has(mime.toLowerCase())
  );
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function primitive(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** qs.stringify(obj, { indices: false, strictNullHandling: true }) for the shapes tests use. */
export function stringifyQuery(value: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (key: string, entry: unknown): void => {
    if (entry === undefined) return;
    if (entry === null) {
      parts.push(encode(key));
    } else if (Array.isArray(entry)) {
      for (const item of entry) add(key, item);
    } else if (typeof entry === 'object' && !(entry instanceof Date)) {
      for (const [child, nested] of Object.entries(entry))
        add(`${key}[${child}]`, nested);
    } else {
      parts.push(`${encode(key)}=${encode(primitive(entry))}`);
    }
  };
  for (const [key, entry] of Object.entries(value)) add(key, entry);
  return parts.join('&');
}

function parseLinks(header: string | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(/ *, */)) {
    const match = /^<?([^>]*)>? *; *rel="?([^"]*)"?/.exec(part);
    if (match?.[1] !== undefined && match[2] !== undefined)
      links[match[2]] = match[1];
  }
  return links;
}

function statusError(
  message: string,
  expected?: unknown,
  actual?: unknown,
): Error {
  const error = new Error(message) as Error & {
    expected?: unknown;
    actual?: unknown;
    showDiff?: boolean;
  };
  if (arguments.length > 1) {
    error.expected = expected;
    error.actual = actual;
    error.showDiff = true;
  }
  return error;
}

export class Test implements PromiseLike<Response> {
  private readonly headers: Record<string, string> = {};
  private readonly queryParts: string[] = [];
  private queryObject: Record<string, unknown> = {};
  private data: unknown;
  private parts: Part[] | undefined;
  private readonly asserts: Assertion[] = [];
  private promise: Promise<Response> | undefined;

  private readonly app: RequestListener | Server;
  private readonly method: string;
  private readonly path: string;
  private request: http.ClientRequest | undefined;
  private aborted = false;

  constructor(app: RequestListener | Server, method: string, path: string) {
    this.app = app;
    this.method = method;
    this.path = path;
  }

  set(field: string | Record<string, string>, value?: string): this {
    if (typeof field === 'object') {
      for (const [name, entry] of Object.entries(field)) this.set(name, entry);
      return this;
    }
    this.headers[field.toLowerCase()] = String(value);
    return this;
  }

  type(value: string): this {
    const aliases: Record<string, string> = {
      json: 'application/json',
      form: 'application/x-www-form-urlencoded',
      'form-data': 'multipart/form-data',
      text: 'text/plain',
      html: 'text/html',
      xml: 'application/xml',
    };
    return this.set('content-type', aliases[value] ?? value);
  }

  query(value: string | Record<string, unknown>): this {
    if (typeof value === 'string') this.queryParts.push(value);
    else Object.assign(this.queryObject, value);
    return this;
  }

  send(data?: unknown): this {
    if (this.parts)
      throw new Error(".send() can't be used if .attach() or .field() is used");
    const isObject = data !== null && typeof data === 'object';
    const isHost = Buffer.isBuffer(data);
    const contentType = this.headers['content-type'];
    if (isObject && !isHost) {
      if (this.data === undefined) this.data = Array.isArray(data) ? [] : {};
      Object.assign(this.data as object, data);
      if (!contentType) this.type('json');
    } else if (typeof data === 'string') {
      if (!contentType) this.type('form');
      const type = this.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      const previous = typeof this.data === 'string' ? this.data : '';
      this.data =
        type === 'application/x-www-form-urlencoded' && previous
          ? `${previous}&${data}`
          : previous + data;
    } else {
      this.data = data;
    }
    return this;
  }

  field(name: string, value: string | number | boolean | Buffer): this {
    if (this.data !== undefined)
      throw new Error(".field() can't be used if .send() is used");
    (this.parts ??= []).push({ name, value: String(value) });
    return this;
  }

  attach(
    name: string,
    file: Buffer | string,
    options: string | AttachOptions = {},
  ): this {
    if (this.data !== undefined)
      throw new Error(".attach() can't be used if .send() is used");
    const opts = typeof options === 'string' ? { filename: options } : options;
    (this.parts ??= []).push({
      name,
      file: typeof file === 'string' ? fs.readFileSync(file) : file,
      filename: opts.filename ?? (typeof file === 'string' ? file : 'file'),
      contentType: opts.contentType ?? 'application/octet-stream',
    });
    return this;
  }

  expect(status: number, callback?: CallbackHandler): this;
  expect(status: number, body: unknown, callback?: CallbackHandler): this;
  expect(checker: (res: Response) => unknown, callback?: CallbackHandler): this;
  expect(body: string | RegExp | object, callback?: CallbackHandler): this;
  expect(field: string, value: string | RegExp, callback?: CallbackHandler): this;
  expect(a: unknown, b?: unknown, c?: unknown): this {
    if (typeof a === 'function') {
      this.asserts.push((res) => {
        try {
          const result = (a as (res: Response) => unknown)(res);
          return result instanceof Error ? result : undefined;
        } catch (error) {
          return error as Error;
        }
      });
      if (typeof b === 'function') this.end(b as CallbackHandler);
      return this;
    }
    if (typeof b === 'function') this.end(b as CallbackHandler);
    if (typeof c === 'function') this.end(c as CallbackHandler);
    if (typeof a === 'number') {
      this.asserts.push((res) =>
        res.status === a
          ? undefined
          : new Error(
              `expected ${a} "${http.STATUS_CODES[a]}", got ${res.status} "${http.STATUS_CODES[res.status]}"`,
            ),
      );
      if (typeof b !== 'function' && arguments.length > 1)
        this.asserts.push((res) => assertBody(b, res));
      return this;
    }
    if (
      Array.isArray(a) &&
      a.length > 0 &&
      a.every((entry) => typeof entry === 'number')
    ) {
      this.asserts.push((res) =>
        (a as number[]).includes(res.status)
          ? undefined
          : new Error(
              `expected one of "${a.join(', ')}", got ${res.status} "${http.STATUS_CODES[res.status]}"`,
            ),
      );
      return this;
    }
    if (typeof b === 'string' || typeof b === 'number' || b instanceof RegExp) {
      const name = String(a);
      this.asserts.push((res) => assertHeader(name, b, res));
      return this;
    }
    this.asserts.push((res) => assertBody(a, res));
    return this;
  }

  end(callback?: CallbackHandler): this {
    this.run().then(
      (res) => callback?.call(this, null, res),
      (error: unknown) =>
        callback?.call(this, error, (error as { response?: Response }).response as Response),
    );
    return this;
  }

  /** Destroy the in-flight request; a pending promise or `.end()` callback gets the error. */
  abort(): this {
    this.aborted = true;
    this.request?.destroy(new Error('Aborted'));
    return this;
  }

  then<T1 = Response, T2 = never>(
    onFulfilled?: ((value: Response) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.run().then(onFulfilled, onRejected);
  }

  catch<T = never>(
    onRejected?: ((reason: unknown) => T | PromiseLike<T>) | null,
  ): Promise<Response | T> {
    return this.run().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<Response> {
    return this.run().finally(onFinally);
  }

  private run(): Promise<Response> {
    this.promise ??= this.execute().then((res) => {
      for (const assertion of this.asserts) {
        const error = assertion(res);
        if (error) {
          (error as Error & { response?: Response }).response = res;
          throw error;
        }
      }
      return res;
    });
    return this.promise;
  }

  private body(): Buffer | undefined {
    if (this.parts) {
      const boundary = `--------------------------${crypto.randomBytes(12).toString('hex')}`;
      this.headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      const chunks: Buffer[] = [];
      for (const part of this.parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if ('file' in part)
          head += `; filename="${part.filename}"\r\nContent-Type: ${part.contentType}`;
        chunks.push(Buffer.from(`${head}\r\n\r\n`));
        chunks.push('file' in part ? part.file : Buffer.from(part.value));
        chunks.push(Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return Buffer.concat(chunks);
    }
    if (this.data === undefined || this.method === 'HEAD') return undefined;
    if (typeof this.data === 'string') return Buffer.from(this.data);
    if (Buffer.isBuffer(this.data)) return this.data;
    const type = this.headers['content-type']?.split(';')[0];
    if (type === 'application/x-www-form-urlencoded')
      return Buffer.from(stringifyQuery(this.data as Record<string, unknown>));
    if (type === undefined || isJson(type))
      return Buffer.from(JSON.stringify(this.data));
    return Buffer.from(String(this.data));
  }

  private url(port: number): string {
    const query = [...this.queryParts];
    const fromObject = stringifyQuery(this.queryObject);
    if (fromObject) query.push(fromObject);
    let target = this.path;
    if (query.length > 0)
      target += (target.includes('?') ? '&' : '?') + query.join('&');
    return `http://127.0.0.1:${port}${target}`;
  }

  private async execute(): Promise<Response> {
    const server =
      typeof this.app === 'function' ? http.createServer(this.app) : this.app;
    const ownServer = !server.listening;
    if (ownServer)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      const { port } = server.address() as AddressInfo;
      const payload = this.body();
      const headers: Record<string, string> = {
        'accept-encoding': 'gzip, deflate',
        ...this.headers,
      };
      if (payload && headers['content-length'] === undefined)
        headers['content-length'] = String(payload.length);
      return await new Promise<Response>((resolve, reject) => {
        if (this.aborted) {
          reject(new Error('The request has been aborted even before .end() was called'));
          return;
        }
        const request = http.request(
          this.url(port),
          { method: this.method, headers, agent: false },
          (incoming) => {
            const chunks: Buffer[] = [];
            const encoding = incoming.headers['content-encoding'];
            const stream =
              encoding === 'gzip'
                ? incoming.pipe(zlib.createGunzip())
                : encoding === 'deflate'
                  ? incoming.pipe(zlib.createInflate())
                  : incoming;
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
              try {
                resolve(
                  buildResponse(
                    this.method,
                    incoming.statusCode ?? 0,
                    incoming.headers,
                    Buffer.concat(chunks),
                  ),
                );
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        this.request = request;
        request.on('error', reject);
        request.end(payload);
      });
    } finally {
      if (ownServer)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function buildResponse(
  method: string,
  status: number,
  headers: IncomingHttpHeaders,
  raw: Buffer,
): Response {
  const contentType = headers['content-type'] ?? '';
  const mime = contentType.split(/ *; */)[0] || 'text/plain';
  const params: Record<string, string> = {};
  for (const part of contentType.split(/ *; */).slice(1)) {
    const [key, value] = part.split(/ *= */);
    if (key && value) params[key.toLowerCase()] = value;
  }
  let body: unknown;
  let text: string | undefined;
  if (method !== 'HEAD') {
    if (isBinary(mime)) {
      body = raw;
    } else if (mime === 'application/x-www-form-urlencoded') {
      text = raw.toString('ascii');
      body = Object.fromEntries(new URLSearchParams(text));
    } else if (isJson(mime) && mime !== 'application/json-seq') {
      text = raw.toString('utf8');
      try {
        body = text && JSON.parse(text);
      } catch (error) {
        Object.assign(error as object, { rawResponse: text, statusCode: status });
        throw error;
      }
    } else {
      text = raw.toString('utf8');
    }
  }
  const kind = Math.trunc(status / 100);
  return {
    status,
    statusCode: status,
    ok: kind === 2,
    clientError: kind === 4,
    serverError: kind === 5,
    body: body === undefined ? {} : body,
    text: text as string,
    type: mime,
    charset: params.charset,
    headers,
    header: headers,
    links: parseLinks(
      Array.isArray(headers.link) ? headers.link.join(', ') : headers.link,
    ),
    get: (field: string) => headers[field.toLowerCase()],
  };
}

function assertBody(expected: unknown, res: Response): Error | undefined {
  if (typeof expected === 'object' && expected !== null && !(expected instanceof RegExp)) {
    try {
      deepStrictEqual(expected, res.body);
    } catch {
      return statusError(
        `expected ${inspect(expected)} response body, got ${inspect(res.body)}`,
        expected,
        res.body,
      );
    }
    return undefined;
  }
  if (expected === res.text) return undefined;
  if (expected instanceof RegExp)
    return expected.test(res.text)
      ? undefined
      : statusError(
          `expected body ${inspect(res.text)} to match ${expected}`,
          expected,
          res.body,
        );
  return statusError(
    `expected ${inspect(expected)} response body, got ${inspect(res.text)}`,
    expected,
    res.body,
  );
}

function assertHeader(
  field: string,
  expected: string | number | RegExp,
  res: Response,
): Error | undefined {
  const actual = res.headers[field.toLowerCase()];
  if (actual === undefined) return new Error(`expected "${field}" header field`);
  if (
    (Array.isArray(actual) && actual.toString() === expected) ||
    expected === actual
  )
    return undefined;
  if (expected instanceof RegExp) {
    return expected.test(String(actual))
      ? undefined
      : new Error(`expected "${field}" matching ${expected}, got "${String(actual)}"`);
  }
  return new Error(`expected "${field}" of "${expected}", got "${String(actual)}"`);
}

export interface TestAgent {
  get(url: string): Test;
  post(url: string): Test;
  put(url: string): Test;
  patch(url: string): Test;
  delete(url: string): Test;
  del(url: string): Test;
  head(url: string): Test;
  options(url: string): Test;
}

/** supertest(app): one agent; each call creates one request. */
export function httpAgent(app: RequestListener | Server): TestAgent {
  const make = (method: string) => (url: string) => new Test(app, method, url);
  return {
    get: make('GET'),
    post: make('POST'),
    put: make('PUT'),
    patch: make('PATCH'),
    delete: make('DELETE'),
    del: make('DELETE'),
    head: make('HEAD'),
    options: make('OPTIONS'),
  };
}
