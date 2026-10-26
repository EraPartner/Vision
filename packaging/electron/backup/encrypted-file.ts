import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Readable, Transform } from "node:stream";

export const V2_SALT_BYTES = 16;
export const RETIRED_V1_MESSAGE =
  "This backup uses the retired v1 encryption format, which Vision no longer restores.";
export const V2_IV_BYTES = 12;
export const V2_TAG_BYTES = 16;
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;

export interface DecryptFileOptions {
  encryptedPath: string;
  destinationPath: string;
  keyOrPassphrase: string | Buffer | null | undefined;
  /** Magic of the retired v1 (AES-CBC, static salt) format, refused by name. */
  retiredV1Magic: Buffer;
  v2Magic: Buffer;
  requiredError: string;
  invalidError: string;
  invalidHeaderMessage: string;
  unsupportedFormatMessage: string;
  retiredFormatMessage: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function deriveKeyV2(
  passphrase: string | null | undefined,
  salt: Buffer,
): Buffer | null {
  if (!passphrase || typeof passphrase !== "string") return null;
  if (!Buffer.isBuffer(salt) || salt.length !== V2_SALT_BYTES) {
    throw new Error("deriveKeyV2 requires a 16-byte salt");
  }
  return crypto.scryptSync(passphrase, salt, 32, {
    N: KDF_N,
    r: KDF_R,
    p: KDF_P,
    maxmem: 128 * KDF_N * KDF_R * 2,
  });
}

async function readMagic(
  filePath: string,
  magicLength: number,
  invalidHeaderMessage: string,
): Promise<Buffer> {
  const magic = Buffer.alloc(magicLength);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { bytesRead } = await handle.read(magic, 0, magicLength, 0);
    if (bytesRead !== magicLength) throw new Error(invalidHeaderMessage);
    return magic;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function isEncryptedFile(
  filePath: string,
  magics: readonly Buffer[],
): Promise<boolean> {
  try {
    const magic = await readMagic(
      filePath,
      // An empty list reads zero bytes and matches nothing, as before.
      magics[0]?.length ?? 0,
      "Invalid encrypted file header.",
    );
    return magics.some((candidate) => magic.equals(candidate));
  } catch {
    return false;
  }
}

function removePartialFile(
  cleanupPath: string,
  callback: (error?: NodeJS.ErrnoException) => void,
): void {
  fs.unlink(cleanupPath, (err) => {
    if (err && err.code !== "ENOENT") {
      callback(err);
      return;
    }
    callback();
  });
}

/**
 * Pipe input through cipher into output. When `readAuthTag` is given, the
 * output stays open after the cipher ends and the GCM tag is appended.
 */
function pipeCipher(
  input: Readable,
  cipher: Transform,
  output: fs.WriteStream,
  cleanupPath: string,
  readAuthTag?: () => Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      const rejectAfterCleanup = () => {
        removePartialFile(cleanupPath, (cleanupError) => {
          if (cleanupError && isRecord(err)) {
            err.cleanupError = cleanupError;
          }
          reject(toError(err));
        });
      };
      input.destroy();
      cipher.destroy();
      if (output.closed) {
        rejectAfterCleanup();
        return;
      }
      output.once("close", rejectAfterCleanup);
      output.destroy();
    };
    input.on("error", fail);
    cipher.on("error", fail);
    output.on("error", fail);
    input.pipe(cipher).pipe(output, { end: !readAuthTag });
    if (readAuthTag) {
      cipher.on("end", () => {
        try {
          output.end(readAuthTag());
        } catch (err) {
          fail(err);
        }
      });
    }
    output.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

export async function encryptFileV2(
  sourcePath: string,
  destinationPath: string,
  passphrase: string,
  magic: Buffer,
): Promise<void> {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("Encryption requires a passphrase.");
  }
  const salt = crypto.randomBytes(V2_SALT_BYTES);
  const iv = crypto.randomBytes(V2_IV_BYTES);
  const key = deriveKeyV2(passphrase, salt);
  if (!key) throw new Error("Encryption requires a passphrase.");
  try {
    const input = fs.createReadStream(sourcePath);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const output = fs.createWriteStream(destinationPath);
    output.write(magic);
    output.write(salt);
    output.write(iv);
    await pipeCipher(input, cipher, output, destinationPath, () =>
      cipher.getAuthTag(),
    );
  } finally {
    key.fill(0);
  }
}

// Stream and cipher failures are always Errors; anything else is wrapped so the
// promise never rejects with a non-Error.
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isAuthenticationFailure(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const message = typeof err.message === "string" ? err.message : "";
  return (
    /unable to authenticate|bad decrypt|wrong final block|unsupported state/i.test(
      message,
    ) ||
    err.code === "ERR_OSSL_BAD_DECRYPT" ||
    err.code === "ERR_CRYPTO_INVALID_AUTH_TAG"
  );
}

export async function decryptFile({
  encryptedPath,
  destinationPath,
  keyOrPassphrase,
  retiredV1Magic,
  v2Magic,
  requiredError,
  invalidError,
  invalidHeaderMessage,
  unsupportedFormatMessage,
  retiredFormatMessage,
}: DecryptFileOptions): Promise<void> {
  if (
    keyOrPassphrase === null ||
    keyOrPassphrase === undefined ||
    keyOrPassphrase === ""
  ) {
    throw new Error(requiredError);
  }
  const magic = await readMagic(
    encryptedPath,
    v2Magic.length,
    invalidHeaderMessage,
  );
  if (magic.equals(retiredV1Magic)) throw new Error(retiredFormatMessage);
  if (!magic.equals(v2Magic)) throw new Error(unsupportedFormatMessage);

  let key: Buffer | null | undefined;
  try {
    const headerLength = v2Magic.length + V2_SALT_BYTES + V2_IV_BYTES;
    const header = Buffer.alloc(headerLength);
    const tag = Buffer.alloc(V2_TAG_BYTES);
    let size: number;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.promises.open(encryptedPath, "r");
      ({ size } = await handle.stat());
      if (size < headerLength + V2_TAG_BYTES)
        throw new Error(invalidHeaderMessage);
      const headerRead = await handle.read(header, 0, headerLength, 0);
      if (headerRead.bytesRead !== headerLength)
        throw new Error(invalidHeaderMessage);
      const tagRead = await handle.read(
        tag,
        0,
        V2_TAG_BYTES,
        size - V2_TAG_BYTES,
      );
      if (tagRead.bytesRead !== V2_TAG_BYTES)
        throw new Error(invalidHeaderMessage);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
    }
    const salt = header.subarray(
      v2Magic.length,
      v2Magic.length + V2_SALT_BYTES,
    );
    const iv = header.subarray(v2Magic.length + V2_SALT_BYTES);
    key = Buffer.isBuffer(keyOrPassphrase)
      ? keyOrPassphrase
      : deriveKeyV2(keyOrPassphrase, salt);
    if (!key) throw new Error(requiredError);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const cipherTextLength = size - headerLength - V2_TAG_BYTES;
    await pipeCipher(
      fs.createReadStream(encryptedPath, {
        start: headerLength,
        end: headerLength + cipherTextLength - 1,
      }),
      decipher,
      fs.createWriteStream(destinationPath),
      destinationPath,
    );
  } catch (err) {
    if (isAuthenticationFailure(err)) throw new Error(invalidError);
    throw err;
  } finally {
    if (typeof keyOrPassphrase === "string" && Buffer.isBuffer(key))
      key.fill(0);
  }
}
