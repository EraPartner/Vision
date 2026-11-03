/**
 * ZIP reading and writing for .visionbak bundles, using only node builtins.
 *
 * The reader treats the archive as untrusted: it reads the central
 * directory, refuses encrypted entries, unknown compression, symlinks and
 * other non-regular files, absolute or `..` paths, backslashes, duplicate
 * names (also after macOS case and Unicode folding), overlapping entries and
 * more than the 2.0 restore limits (100,000 entries, 10 GiB). Every entry is
 * checked against its declared size and CRC-32 while it is extracted.
 *
 * The writer produces the layout the 2.0 bundle writer
 * (packaging/electron/backup/zip-writer.ts at 2.0.0) produced: deflated
 * files, directory entries with a trailing "/", Unix modes, the UTF-8 name
 * flag for non-ASCII names, DOS timestamps, and ZIP64 records where a size,
 * offset or the entry count needs them.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { TransitionError } from "./errors.ts";
import { at } from "./util.ts";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const UTF8_NAMES = 0x0800;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** The 2.0 restore limits (packaging/electron/backup/bundle.ts at 2.0.0). */
export const MAX_ENTRIES = 100_000;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_NAME_BYTES = 1024;

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Offset of the entry's data, from its local header. */
  dataOffset: number;
}

function zipError(message: string): TransitionError {
  return new TransitionError(`The backup is not a valid Vision bundle: ${message}`, {
    hint: "Use the .visionbak file exactly as Vision 2.0 wrote it. If it was copied or synced, copy it again.",
  });
}

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw zipError("unexpected end of file");
    done += bytesRead;
  }
  return buffer;
}

/** Check an entry name and return its folding key for duplicate detection. */
export function validateEntryName(name: string): string {
  if (name.length === 0) throw zipError("an entry has an empty name");
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw zipError(`entry name with a control character or backslash: ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw zipError(`absolute entry path: ${JSON.stringify(name)}`);
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw zipError(`unsafe entry path: ${JSON.stringify(name)}`);
    }
  }
  // APFS compares names case-insensitively and normalization-insensitively.
  return name.normalize("NFC").toLowerCase();
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Read and validate the central directory. */
export async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < 22) throw zipError("file too small to be a zip archive");
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw zipError("no end of central directory record");
    const eocdOffset = size - tailLength + eocd;
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw zipError("multi-disk archives are not supported");
    }
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === UINT16_MAX || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
      if (eocdOffset < 20) throw zipError("missing ZIP64 locator");
      const locator = await readAt(handle, eocdOffset - 20, 20);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw zipError("missing ZIP64 locator");
      const end64Offset = Number(locator.readBigUInt64LE(8));
      const end64 = await readAt(handle, end64Offset, 56);
      if (end64.readUInt32LE(0) !== ZIP64_END) throw zipError("bad ZIP64 end record");
      count = Number(end64.readBigUInt64LE(32));
      cdSize = Number(end64.readBigUInt64LE(40));
      cdOffset = Number(end64.readBigUInt64LE(48));
    }
    if (count > MAX_ENTRIES) throw zipError(`too many entries (${count} > ${MAX_ENTRIES})`);
    if (cdOffset + cdSize > eocdOffset) throw zipError("central directory overlaps the end record");
    const cd = await readAt(handle, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let pos = 0;
    let declaredTotal = 0;
    for (let n = 0; n < count; n++) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== CENTRAL_HEADER) throw zipError("bad central directory entry");
      const madeBy = cd.readUInt16LE(pos + 4);
      const flags = cd.readUInt16LE(pos + 8);
      const method = cd.readUInt16LE(pos + 10);
      const crc = cd.readUInt32LE(pos + 16);
      let compressedSize = cd.readUInt32LE(pos + 20);
      let uncompressedSize = cd.readUInt32LE(pos + 24);
      const nameLength = cd.readUInt16LE(pos + 28);
      const extraLength = cd.readUInt16LE(pos + 30);
      const commentLength = cd.readUInt16LE(pos + 32);
      const externalAttributes = cd.readUInt32LE(pos + 38);
      let localHeaderOffset = cd.readUInt32LE(pos + 42);
      const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLength);
      const extra = cd.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
      pos += 46 + nameLength + extraLength + commentLength;
      if (pos > cd.length) throw zipError("truncated central directory");
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
        throw zipError("encrypted zip entries are not supported");
      }
      if (method !== 0 && method !== 8) throw zipError(`unsupported compression method ${method}`);
      if (nameLength > MAX_NAME_BYTES) throw zipError("entry name too long");
      if ((flags & UTF8_NAMES) === 0 && nameBytes.some((b) => b >= 0x80)) {
        throw zipError("entry name is not marked as UTF-8");
      }
      let name: string;
      try {
        name = utf8.decode(nameBytes);
      } catch {
        throw zipError("entry name is not valid UTF-8");
      }
      // ZIP64 extra field: the values whose 32-bit fields are saturated, in order.
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === ZIP64_EXTRA) {
          let f = e + 4;
          const next = () => {
            if (f + 8 > e + 4 + len) throw zipError("short ZIP64 extra field");
            const value = Number(extra.readBigUInt64LE(f));
            f += 8;
            return value;
          };
          if (uncompressedSize === UINT32_MAX) uncompressedSize = next();
          if (compressedSize === UINT32_MAX) compressedSize = next();
          if (localHeaderOffset === UINT32_MAX) localHeaderOffset = next();
        }
        e += 4 + len;
      }
      const key = validateEntryName(name);
      if (seen.has(key)) throw zipError(`duplicate entry ${JSON.stringify(name)}`);
      seen.add(key);
      const host = madeBy >> 8;
      const unixMode = host === 3 ? (externalAttributes >>> 16) & S_IFMT : 0;
      const isDirectory = name.endsWith("/");
      if (unixMode !== 0) {
        if (unixMode === 0o120000) throw zipError(`symbolic links are not allowed: ${JSON.stringify(name)}`);
        if (unixMode !== S_IFREG && unixMode !== S_IFDIR) throw zipError(`special file in bundle: ${JSON.stringify(name)}`);
        if ((unixMode === S_IFDIR) !== isDirectory) throw zipError(`entry type does not match its name: ${JSON.stringify(name)}`);
      }
      if (isDirectory && uncompressedSize !== 0) throw zipError(`directory entry with data: ${JSON.stringify(name)}`);
      declaredTotal += uncompressedSize;
      if (declaredTotal > MAX_TOTAL_BYTES) throw zipError(`more than ${MAX_TOTAL_BYTES} bytes uncompressed`);
      entries.push({
        name,
        isDirectory,
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dataOffset: -1,
      });
    }
    if (pos !== cd.length) throw zipError("central directory size mismatch");
    // Local headers: names and methods must agree; data ranges must not overlap.
    for (const entry of entries) {
      if (entry.localHeaderOffset + 30 > cdOffset) throw zipError("entry outside the archive data");
      const header = await readAt(handle, entry.localHeaderOffset, 30);
      if (header.readUInt32LE(0) !== LOCAL_HEADER) throw zipError(`bad local header for ${entry.name}`);
      const flags = header.readUInt16LE(6);
      if ((flags & 0x0001) !== 0) throw zipError("encrypted zip entries are not supported");
      if (header.readUInt16LE(8) !== entry.method) throw zipError(`compression method mismatch for ${entry.name}`);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const localName = await readAt(handle, entry.localHeaderOffset + 30, nameLength);
      if (!localName.equals(Buffer.from(entry.name, "utf8"))) throw zipError(`local name mismatch for ${entry.name}`);
      entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
      if (entry.dataOffset + entry.compressedSize > cdOffset) throw zipError(`entry ${entry.name} runs past the archive data`);
    }
    const ranges = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    for (let i = 1; i < ranges.length; i++) {
      const previous = at(ranges, i - 1);
      if (previous.dataOffset + previous.compressedSize > at(ranges, i).localHeaderOffset) {
        throw zipError("overlapping entries");
      }
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export interface ExtractResult {
  bytes: number;
  sha256: string;
}

/**
 * Stream one entry's data through `sink`, checking its size and CRC-32,
 * and return its SHA-256.
 */
export async function streamEntry(
  file: string,
  entry: ZipEntry,
  sink: (chunk: Buffer) => void | Promise<void>,
  budget: { remaining: number },
): Promise<ExtractResult> {
  const hash = createHash("sha256");
  let crc = 0;
  let bytes = 0;
  const source: Readable =
    entry.compressedSize === 0
      ? Readable.from([])
      : fs.createReadStream(file, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  const stages: Array<NodeJS.ReadWriteStream> = [];
  if (entry.method === 8) stages.push(zlib.createInflateRaw());
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      budget.remaining -= chunk.length;
      if (bytes > entry.uncompressedSize) {
        callback(zipError(`${entry.name} is larger than its declared size`));
        return;
      }
      if (budget.remaining < 0) {
        callback(zipError(`more than ${MAX_TOTAL_BYTES} bytes uncompressed (possible zip bomb)`));
        return;
      }
      crc = zlib.crc32(chunk, crc);
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, ...stages, check, async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) await sink(chunk);
    });
  } catch (err) {
    if (err instanceof TransitionError) throw err;
    throw zipError(`${entry.name} cannot be decompressed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (bytes !== entry.uncompressedSize) throw zipError(`${entry.name} is shorter than its declared size`);
  if ((crc >>> 0) !== entry.crc32) throw zipError(`${entry.name} fails its CRC-32 check (the file is damaged)`);
  return { bytes, sha256: hash.digest("hex") };
}

/** Extract one regular entry to a new file (never overwriting). */
export async function extractEntryToFile(
  file: string,
  entry: ZipEntry,
  destination: string,
  budget: { remaining: number },
): Promise<ExtractResult> {
  const handle = await fs.promises.open(destination, "wx", 0o600);
  try {
    const result = await streamEntry(
      file,
      entry,
      async (chunk) => {
        let done = 0;
        while (done < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, done, chunk.length - done);
          done += bytesWritten;
        }
      },
      budget,
    );
    await handle.sync();
    return result;
  } finally {
    await handle.close();
  }
}

/** Read a small entry into memory. */
export async function readEntry(file: string, entry: ZipEntry, budget: { remaining: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await streamEntry(file, entry, (chunk) => void chunks.push(chunk), budget);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  externalAttributes: number;
  zip64Sizes: boolean;
}

/** Unix host, spec version 4.5, as the 2.0 writer (and archiver) wrote. */
const VERSION_MADE_BY = (3 << 8) | 45;
const ZIP64_FILE_THRESHOLD = 0xf0000000;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipWriter {
  addDirectory(name: string, date?: Date): Promise<void>;
  addFile(name: string, sourcePath: string): Promise<void>;
  addBuffer(name: string, data: Buffer, date?: Date): Promise<void>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}

/** Create a new archive at `file`; refuses an existing file. */
export async function createZipWriter(file: string): Promise<ZipWriter> {
  const handle = await fs.promises.open(file, "wx", 0o600);
  const records: CentralRecord[] = [];
  let position = 0;
  let closed = false;

  const writeAt = async (buffer: Buffer, at: number) => {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, at + done);
      done += bytesWritten;
    }
  };
  const write = async (buffer: Buffer) => {
    await writeAt(buffer, position);
    position += buffer.length;
  };
  const nameOf = (name: string) => {
    validateEntryName(name);
    return Buffer.from(name, "utf8");
  };
  const flagsFor = (name: string) => (/^[\x00-\x7f]*$/.test(name) ? 0 : UTF8_NAMES);

  const writeLocal = async (name: Buffer, flags: number, method: number, dos: { time: number; date: number }, zip64: boolean) => {
    const extra = Buffer.alloc(zip64 ? 20 : 0);
    if (zip64) {
      extra.writeUInt16LE(ZIP64_EXTRA, 0);
      extra.writeUInt16LE(16, 2);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(zip64 ? 45 : method === 8 ? 20 : 10, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dos.time, 10);
    header.writeUInt16LE(dos.date, 12);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const offset = position;
    await write(Buffer.concat([header, name, extra]));
    return offset;
  };

  const patchLocal = async (offset: number, nameLength: number, zip64: boolean, crc: number, csize: number, usize: number) => {
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc >>> 0, 0);
    if (zip64) {
      sizes.writeUInt32LE(UINT32_MAX, 4);
      sizes.writeUInt32LE(UINT32_MAX, 8);
      const extra = Buffer.alloc(16);
      extra.writeBigUInt64LE(BigInt(usize), 0);
      extra.writeBigUInt64LE(BigInt(csize), 8);
      await writeAt(extra, offset + 30 + nameLength + 4);
    } else {
      if (csize >= UINT32_MAX || usize >= UINT32_MAX) throw new Error("zip entry grew past 4 GiB without ZIP64 fields");
      sizes.writeUInt32LE(csize, 4);
      sizes.writeUInt32LE(usize, 8);
    }
    await writeAt(sizes, offset + 14);
  };

  const addDeflated = async (entryName: string, source: Readable, date: Date, mode: number, expectedSize: number) => {
    const name = nameOf(entryName);
    const flags = flagsFor(entryName);
    const dos = dosDateTime(date);
    const zip64 = expectedSize >= ZIP64_FILE_THRESHOLD;
    const offset = await writeLocal(name, flags, 8, dos, zip64);
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const checksum = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crc = zlib.crc32(chunk, crc);
        usize += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(source, checksum, zlib.createDeflateRaw({ level: 6 }), async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) {
        await write(chunk);
        csize += chunk.length;
      }
    });
    await patchLocal(offset, name.length, zip64, crc, csize, usize);
    records.push({
      name,
      flags,
      method: 8,
      time: dos.time,
      date: dos.date,
      crc: crc >>> 0,
      compressedSize: csize,
      uncompressedSize: usize,
      offset,
      externalAttributes: ((S_IFREG | (mode & 0o7777)) << 16) >>> 0,
      zip64Sizes: zip64,
    });
  };

  const writeCentral = async () => {
    const start = position;
    for (const r of records) {
      const zip64Offset = r.offset >= UINT32_MAX;
      const fields: bigint[] = [];
      if (r.zip64Sizes) fields.push(BigInt(r.uncompressedSize), BigInt(r.compressedSize));
      if (zip64Offset) fields.push(BigInt(r.offset));
      const extra = Buffer.alloc(fields.length > 0 ? 4 + fields.length * 8 : 0);
      if (fields.length > 0) {
        extra.writeUInt16LE(ZIP64_EXTRA, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((value, i) => extra.writeBigUInt64LE(value, 4 + i * 8));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(fields.length > 0 ? 45 : r.method === 8 ? 20 : 10, 6);
      header.writeUInt16LE(r.flags, 8);
      header.writeUInt16LE(r.method, 10);
      header.writeUInt16LE(r.time, 12);
      header.writeUInt16LE(r.date, 14);
      header.writeUInt32LE(r.crc, 16);
      header.writeUInt32LE(r.zip64Sizes ? UINT32_MAX : r.compressedSize, 20);
      header.writeUInt32LE(r.zip64Sizes ? UINT32_MAX : r.uncompressedSize, 24);
      header.writeUInt16LE(r.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(r.externalAttributes, 38);
      header.writeUInt32LE(zip64Offset ? UINT32_MAX : r.offset, 42);
      await write(Buffer.concat([header, r.name, extra]));
    }
    const size = position - start;
    const zip64End = records.length >= UINT16_MAX || size >= UINT32_MAX || start >= UINT32_MAX;
    if (zip64End) {
      const endOffset = position;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(ZIP64_END, 0);
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

  return {
    async addDirectory(entryName, date = new Date()) {
      const nameText = entryName.endsWith("/") ? entryName : `${entryName}/`;
      const name = nameOf(nameText);
      const flags = flagsFor(nameText);
      const dos = dosDateTime(date);
      const offset = await writeLocal(name, flags, 0, dos, false);
      await patchLocal(offset, name.length, false, 0, 0, 0);
      records.push({
        name,
        flags,
        method: 0,
        time: dos.time,
        date: dos.date,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        offset,
        externalAttributes: (((S_IFDIR | 0o700) << 16) | 0x10) >>> 0,
        zip64Sizes: false,
      });
    },
    async addFile(entryName, sourcePath) {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) throw new Error(`not a file: ${sourcePath}`);
      await addDeflated(entryName, fs.createReadStream(sourcePath), stat.mtime, 0o600, stat.size);
    },
    async addBuffer(entryName, data, date = new Date()) {
      await addDeflated(entryName, Readable.from([data]), date, 0o600, data.length);
    },
    async finalize() {
      await writeCentral();
      await handle.sync();
      await close();
    },
    abort: close,
  };
}
