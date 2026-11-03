/**
 * File helpers for the transition: hashing, durable writes and copies that
 * never overwrite.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Text(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** fsync a directory so a new name in it survives a crash. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.promises.open(dir, "r");
  try {
    await handle.sync();
  } catch (err) {
    // Some file systems refuse fsync on a directory; the data itself is synced.
    if ((err as NodeJS.ErrnoException).code !== "EINVAL" && (err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
  } finally {
    await handle.close();
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Write a new file (never replacing one) and fsync it. */
export async function writeNewFile(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const handle = await fs.promises.open(file, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fs.promises.rm(file, { force: true });
    throw err;
  }
  await handle.close();
}

/**
 * Copy `source` to a new file `destination` (refusing an existing one),
 * fsync it and return the SHA-256 of what was written, read back from disk.
 */
export async function copyNewFile(source: string, destination: string, mode = 0o600): Promise<string> {
  const handle = await fs.promises.open(destination, "wx", mode);
  try {
    for await (const chunk of fs.createReadStream(source)) {
      const buffer = chunk as Buffer;
      let done = 0;
      while (done < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, done, buffer.length - done);
        done += bytesWritten;
      }
    }
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fs.promises.rm(destination, { force: true });
    throw err;
  }
  await handle.close();
  return sha256File(destination);
}

/** Create a directory (and parents) with private permissions. */
export async function makePrivateDirectory(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** True when `child` is `parent` or lies below it (after resolving). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
