/**
 * Streaming ZIP writer for .visionbak bundles (ADR-245; replaces `archiver`).
 *
 * Writes the same entry layout archiver 8 wrote: deflated files, directory
 * entries with a trailing "/", symlinks stored as their target text, Unix
 * modes in the external attributes, the UTF-8 name flag for non-ASCII names,
 * and DOS timestamps in local time. Unlike archiver
 * it writes each local header with placeholder sizes and patches them after
 * the data, so entries carry no data descriptor.
 *
 * ZIP64 (APPNOTE 6.3.10, section 4.5.3) is used where a size, offset or the
 * entry count does not fit: files whose size on disk is near 4 GiB reserve a
 * ZIP64 extra field in the local header, and the central directory and end
 * record switch to ZIP64 fields when needed. An entry that grows past 4 GiB
 * without a reserved field fails the archive instead of writing a corrupt one.
 *
 * Only node builtins are used; nothing loads until a backup runs.
 */

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const UTF8_NAMES = 0x0800;
/** Unix host, spec version 4.5 — what archiver wrote. */
const VERSION_MADE_BY = (3 << 8) | 45;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Deflate can grow incompressible input a little; leave room below 4 GiB. */
const ZIP64_FILE_THRESHOLD = 0xf0000000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Update a running CRC-32 (start with 0). */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  dos: { time: number; date: number };
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  externalAttributes: number;
  directory: boolean;
  zip64Sizes: boolean;
}

export interface ZipWriterOptions {
  /** zlib deflate level; archiver used 6. */
  level?: number;
  /** Write ZIP64 records for every entry (tests exercise the ZIP64 path). */
  forceZip64?: boolean;
}

export interface EntryOptions {
  date?: Date;
  /** Permission bits; the file type bits are added by the writer. */
  mode?: number;
}

export interface ZipWriter {
  /** Add an in-memory entry (deflated). */
  append(name: string, data: string | Uint8Array, options?: EntryOptions): Promise<void>;
  /** Add a file from disk under `name` (deflated, streamed). */
  file(sourcePath: string, name: string): Promise<void>;
  /**
   * Add a directory tree under `prefix` like archiver's `directory()`:
   * an entry for every subdirectory, file and symlink (the root itself gets
   * none). Other file types are skipped.
   */
  directory(sourceDir: string, prefix: string): Promise<void>;
  /** Write the central directory, flush to disk and close. */
  finalize(): Promise<void>;
  /** Close without finishing; the caller deletes the partial file. */
  abort(): Promise<void>;
}

/** Open `filePath` for writing (truncating it) and return a writer. */
export async function createZipWriter(
  filePath: string,
  { level = 6, forceZip64 = false }: ZipWriterOptions = {},
): Promise<ZipWriter> {
  const handle = await fs.promises.open(filePath, "w");
  const records: CentralRecord[] = [];
  let position = 0;
  let closed = false;

  /** Write at an absolute offset (used to patch a header). */
  const writeAt = async (buffer: Uint8Array, at: number) => {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        done,
        buffer.length - done,
        at + done,
      );
      done += bytesWritten;
    }
  };
  /** Write at the end of the archive. */
  const write = async (buffer: Uint8Array) => {
    await writeAt(buffer, position);
    position += buffer.length;
  };

  const nameBytes = (name: string) => {
    if (name.length === 0 || name.startsWith("/") || name.includes("\\")) {
      throw new Error(`Invalid zip entry name: ${JSON.stringify(name)}`);
    }
    return Buffer.from(name, "utf8");
  };
  // eslint-disable-next-line no-control-regex
  const flagsFor = (name: string) => (/^[\x00-\x7f]*$/.test(name) ? 0 : UTF8_NAMES);

  /** Write a local header; returns where its CRC field starts. */
  const writeLocalHeader = async (
    record: Omit<CentralRecord, "offset" | "crc" | "compressedSize" | "uncompressedSize">,
  ) => {
    const extra = record.zip64Sizes ? Buffer.alloc(20) : Buffer.alloc(0);
    if (record.zip64Sizes) {
      extra.writeUInt16LE(ZIP64_EXTRA, 0);
      extra.writeUInt16LE(16, 2);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(record.zip64Sizes ? 45 : record.method === METHOD_DEFLATE ? 20 : 10, 4);
    header.writeUInt16LE(record.flags, 6);
    header.writeUInt16LE(record.method, 8);
    header.writeUInt16LE(record.dos.time, 10);
    header.writeUInt16LE(record.dos.date, 12);
    header.writeUInt16LE(record.name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const offset = position;
    await write(Buffer.concat([header, record.name, extra]));
    return offset;
  };

  const patchLocalHeader = async (
    offset: number,
    nameLength: number,
    zip64Sizes: boolean,
    crc: number,
    compressedSize: number,
    uncompressedSize: number,
  ) => {
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc, 0);
    if (zip64Sizes) {
      sizes.writeUInt32LE(UINT32_MAX, 4);
      sizes.writeUInt32LE(UINT32_MAX, 8);
      const extra = Buffer.alloc(16);
      extra.writeBigUInt64LE(BigInt(uncompressedSize), 0);
      extra.writeBigUInt64LE(BigInt(compressedSize), 8);
      await writeAt(extra, offset + 30 + nameLength + 4);
    } else {
      if (compressedSize >= UINT32_MAX || uncompressedSize >= UINT32_MAX) {
        throw new Error("Zip entry grew past 4 GiB while it was being written.");
      }
      sizes.writeUInt32LE(compressedSize, 4);
      sizes.writeUInt32LE(uncompressedSize, 8);
    }
    await writeAt(sizes, offset + 14);
  };

  /** Deflate `source` into the archive as one entry. */
  const addDeflated = async (
    name: string,
    source: Iterable<Uint8Array> | NodeJS.ReadableStream,
    { date, mode, expectedSize }: { date: Date; mode: number; expectedSize: number },
  ) => {
    const record = {
      name: nameBytes(name),
      flags: flagsFor(name),
      method: METHOD_DEFLATE,
      dos: dosDateTime(date),
      externalAttributes: ((S_IFREG | (mode & 0o7777)) << 16) >>> 0,
      directory: false,
      zip64Sizes: forceZip64 || expectedSize >= ZIP64_FILE_THRESHOLD,
    };
    const offset = await writeLocalHeader(record);
    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const checksum = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crc = crc32(chunk, crc);
        uncompressedSize += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(
      source,
      checksum,
      zlib.createDeflateRaw({ level }),
      async (deflated: AsyncIterable<Buffer>) => {
        for await (const chunk of deflated) {
          await write(chunk);
          compressedSize += chunk.length;
        }
      },
    );
    await patchLocalHeader(
      offset,
      record.name.length,
      record.zip64Sizes,
      crc,
      compressedSize,
      uncompressedSize,
    );
    records.push({ ...record, offset, crc, compressedSize, uncompressedSize });
  };

  /** Add an entry stored without compression (directories, symlinks). */
  const addStored = async (
    name: string,
    data: Buffer,
    { date, mode, type }: { date: Date; mode: number; type: number },
  ) => {
    const record = {
      name: nameBytes(name),
      flags: flagsFor(name),
      method: METHOD_STORE,
      dos: dosDateTime(date),
      externalAttributes:
        (((type | (mode & 0o7777)) << 16) | (type === S_IFDIR ? 0x10 : 0)) >>> 0,
      directory: type === S_IFDIR,
      zip64Sizes: forceZip64,
    };
    const offset = await writeLocalHeader(record);
    await write(data);
    const crc = crc32(data);
    await patchLocalHeader(offset, record.name.length, record.zip64Sizes, crc, data.length, data.length);
    records.push({
      ...record,
      offset,
      crc,
      compressedSize: data.length,
      uncompressedSize: data.length,
    });
  };

  const writeCentralDirectory = async () => {
    const start = position;
    for (const record of records) {
      const zip64Offset = forceZip64 || record.offset >= UINT32_MAX;
      const fields: bigint[] = [];
      if (record.zip64Sizes) fields.push(BigInt(record.uncompressedSize), BigInt(record.compressedSize));
      if (zip64Offset) fields.push(BigInt(record.offset));
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(ZIP64_EXTRA, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((value, i) => extra.writeBigUInt64LE(value, 4 + i * 8));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(
        fields.length ? 45 : record.method === METHOD_DEFLATE ? 20 : 10,
        6,
      );
      header.writeUInt16LE(record.flags, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(record.dos.time, 12);
      header.writeUInt16LE(record.dos.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.zip64Sizes ? UINT32_MAX : record.compressedSize, 20);
      header.writeUInt32LE(record.zip64Sizes ? UINT32_MAX : record.uncompressedSize, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(record.externalAttributes, 38);
      header.writeUInt32LE(zip64Offset ? UINT32_MAX : record.offset, 42);
      await write(Buffer.concat([header, record.name, extra]));
    }
    const size = position - start;
    const zip64End =
      forceZip64 ||
      records.length >= UINT16_MAX ||
      size >= UINT32_MAX ||
      start >= UINT32_MAX;
    if (zip64End) {
      const endOffset = position;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(VERSION_MADE_BY, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(records.length), 24);
      end64.writeBigUInt64LE(BigInt(records.length), 32);
      end64.writeBigUInt64LE(BigInt(size), 40);
      end64.writeBigUInt64LE(BigInt(start), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR, 0);
      locator.writeBigUInt64LE(BigInt(endOffset), 8);
      locator.writeUInt32LE(1, 16);
      await write(Buffer.concat([end64, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
    const count = zip64End ? UINT16_MAX : records.length;
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(zip64End ? UINT32_MAX : size, 12);
    end.writeUInt32LE(zip64End ? UINT32_MAX : start, 16);
    await write(end);
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  const addPath = async (sourcePath: string, name: string) => {
    const stat = await fs.promises.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(sourcePath);
      await addStored(name, Buffer.from(target), {
        date: stat.mtime,
        mode: stat.mode,
        type: S_IFLNK,
      });
    } else if (stat.isDirectory()) {
      await addStored(`${name}/`, Buffer.alloc(0), {
        date: stat.mtime,
        mode: stat.mode,
        type: S_IFDIR,
      });
    } else if (stat.isFile()) {
      await addDeflated(name, fs.createReadStream(sourcePath), {
        date: stat.mtime,
        mode: stat.mode,
        expectedSize: stat.size,
      });
    }
  };

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = (await fs.promises.readdir(dir)).sort();
    for (const entry of names) {
      const sourcePath = path.join(dir, entry);
      const name = `${prefix}/${entry}`;
      await addPath(sourcePath, name);
      if ((await fs.promises.lstat(sourcePath)).isDirectory()) {
        await walk(sourcePath, name);
      }
    }
  };

  return {
    async append(name, data, { date = new Date(), mode = 0o644 } = {}) {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      await addDeflated(name, [bytes], { date, mode, expectedSize: bytes.length });
    },
    async file(sourcePath, name) {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${sourcePath}`);
      await addDeflated(name, fs.createReadStream(sourcePath), {
        date: stat.mtime,
        mode: stat.mode,
        expectedSize: stat.size,
      });
    },
    async directory(sourceDir, prefix) {
      await walk(sourceDir, prefix.replace(/\/+$/, ""));
    },
    async finalize() {
      await writeCentralDirectory();
      await handle.sync();
      await close();
    },
    abort: close,
  };
}
