/**
 * Stand-in type declarations for `archiver`, until
 * `@types/archiver` can be added as a dev dependency
 * (package installs are currently blocked in the agent sandbox). Delete this
 * file once those packages are installed.
 *
 * Only the slice the backend test suite actually uses is declared. The shapes
 * follow the real @types package (archiver 8), so
 * code written against these declarations keeps compiling when they arrive.
 */

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
