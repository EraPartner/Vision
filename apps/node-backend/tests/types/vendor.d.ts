/**
 * Stand-in type declarations for `supertest` and `archiver`, until
 * `@types/supertest` and `@types/archiver` can be added as dev dependencies
 * (package installs are currently blocked in the agent sandbox). Delete this
 * file once those packages are installed.
 *
 * Only the slice the backend test suite actually uses is declared. The shapes
 * follow the real @types packages (supertest 7 / superagent, archiver 8), so
 * code written against these declarations keeps compiling when they arrive.
 */

declare module "supertest" {
  import type { IncomingHttpHeaders, RequestListener, Server } from "node:http";
  import type { Readable } from "node:stream";

  /** What `supertest(app)` accepts: an http.Server, a request listener (an Express app), or a base URL. */
  export type App = Server | RequestListener | string;

  /** superagent's Response, reduced to the fields the suite reads. */
  export interface Response {
    status: number;
    statusCode: number;
    ok: boolean;
    clientError: boolean;
    serverError: boolean;
    // superagent types the parsed body as `any`; tests narrow it per assertion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: any;
    text: string;
    type: string;
    charset: string;
    headers: IncomingHttpHeaders;
    header: IncomingHttpHeaders;
  }

  // superagent passes `any` as the callback error.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type CallbackHandler = (err: any, res: Response) => void;

  export interface AttachOptions {
    filename?: string;
    contentType?: string;
  }

  /** A pending request: chainable builder that is also a Promise of its Response. */
  export interface Test extends Promise<Response> {
    set(field: string, val: string): this;
    set(fields: Record<string, string>): this;
    query(val: string | Record<string, unknown>): this;
    send(data?: string | object): this;
    field(name: string, val: string | number | boolean | Buffer): this;
    attach(
      field: string,
      file: string | Buffer | Readable,
      options?: string | AttachOptions,
    ): this;
    expect(status: number, callback?: CallbackHandler): this;
    expect(status: number, body: unknown, callback?: CallbackHandler): this;
    expect(
      checker: (res: Response) => unknown,
      callback?: CallbackHandler,
    ): this;
    expect(body: string | RegExp | object, callback?: CallbackHandler): this;
    expect(
      field: string,
      val: string | RegExp,
      callback?: CallbackHandler,
    ): this;
    end(callback?: CallbackHandler): this;
    abort(): this;
  }

  /** The request factory returned by `supertest(app)`. */
  export interface TestAgent<Req extends Test = Test> {
    get(url: string, callback?: CallbackHandler): Req;
    post(url: string, callback?: CallbackHandler): Req;
    put(url: string, callback?: CallbackHandler): Req;
    patch(url: string, callback?: CallbackHandler): Req;
    delete(url: string, callback?: CallbackHandler): Req;
    del(url: string, callback?: CallbackHandler): Req;
    head(url: string, callback?: CallbackHandler): Req;
    options(url: string, callback?: CallbackHandler): Req;
  }

  export interface SupertestOptions {
    http2?: boolean;
  }

  export default function supertest(
    app: App,
    options?: SupertestOptions,
  ): TestAgent<Test>;
}

declare module "archiver" {
  import type { Stats } from "node:fs";
  import type { Readable, Transform } from "node:stream";
  import type { ZlibOptions } from "node:zlib";

  export interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
    prefix?: string;
    stats?: Stats;
  }

  export interface ArchiverOptions {
    statConcurrency?: number;
    highWaterMark?: number;
  }

  export interface ZipOptions extends ArchiverOptions {
    comment?: string;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    namePrependSlash?: boolean;
    store?: boolean;
    zlib?: ZlibOptions;
  }

  /** Core archiver stream: entries go in via `append`, archive bytes come out of the readable side. */
  export class Archiver extends Transform {
    constructor(options?: ArchiverOptions);
    append(source: Readable | Buffer | string, data: EntryData): this;
    finalize(): Promise<void>;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ZipOptions);
  }
}
