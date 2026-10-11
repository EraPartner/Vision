// Minimal ambient declaration for archiver 8 (ESM, no bundled types). Only the
// ZipArchive surface that backup/bundle.ts uses is declared.
declare module "archiver" {
  export interface ZipArchiveOptions {
    zlib?: { level?: number };
  }

  export interface EntryData {
    name: string;
  }

  export class ZipArchive {
    constructor(options?: ZipArchiveOptions);
    on(event: "error", listener: (error: Error) => void): this;
    abort(): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    append(source: string | Buffer, data: EntryData): this;
    file(filepath: string, data: EntryData): this;
    directory(dirpath: string, destpath: string): this;
    finalize(): Promise<void>;
  }
}
