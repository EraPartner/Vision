// Minimal ambient declaration for yauzl 3 (no bundled types). Only the
// lazy-entry read surface that backup/bundle.ts uses is declared.
declare module "yauzl" {
  import type { Readable } from "node:stream";

  export interface Options {
    lazyEntries?: boolean;
    autoClose?: boolean;
  }

  export interface Entry {
    fileName: string;
    uncompressedSize: number;
  }

  export interface ZipFile {
    readEntry(): void;
    openReadStream(
      entry: Entry,
      callback: (error: Error | null, stream: Readable) => void,
    ): void;
    on(event: "entry", listener: (entry: Entry) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export function open(
    path: string,
    options: Options,
    callback: (error: Error | null, zipfile: ZipFile) => void,
  ): void;
}
