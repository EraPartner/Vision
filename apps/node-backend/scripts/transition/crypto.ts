/**
 * The encrypted `.visionbak.enc` container of Vision 2.0
 * (packaging/electron/backup/encrypted-file.ts and bundle.ts at 2.0.0):
 *
 *   "VISIONBAK2" | salt (16) | iv (12) | AES-256-GCM ciphertext | tag (16)
 *
 * with the key derived by scrypt (N = 2^15, r = 8, p = 1) from the
 * passphrase as UTF-8. The retired v1 (CBC) format is refused by name.
 *
 * Decryption streams into a private temporary file and only reports success
 * after GCM has authenticated the whole ciphertext; a caller never reads the
 * plaintext of a file that failed authentication, and the partial output is
 * deleted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { TransitionError } from "./errors.ts";

export const BUNDLE_MAGIC_V1 = Buffer.from("VISIONBAK1");
export const BUNDLE_MAGIC_V2 = Buffer.from("VISIONBAK2");
/** Raw database backups of Vision 1.x/2.0 (`.sql.enc`), not bundles. */
const RAW_BACKUP_MAGICS = [Buffer.from("VISIONENC1"), Buffer.from("VISIONENC2")];
const ZIP_MAGICS = [Buffer.from("PK\x03\x04", "latin1"), Buffer.from("PK\x05\x06", "latin1")];

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = BUNDLE_MAGIC_V2.length + SALT_BYTES + IV_BYTES;
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;

export type InputKind = "zip" | "encrypted-v2";

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, {
    N: KDF_N,
    r: KDF_R,
    p: KDF_P,
    maxmem: 128 * KDF_N * KDF_R * 2,
  });
}

async function readAt(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Tell a plain bundle from an encrypted one, and refuse everything else by name. */
export async function detectInputKind(file: string): Promise<InputKind> {
  const head = await readAt(file, 0, BUNDLE_MAGIC_V2.length);
  if (ZIP_MAGICS.some((magic) => head.subarray(0, magic.length).equals(magic))) return "zip";
  if (head.equals(BUNDLE_MAGIC_V2)) return "encrypted-v2";
  if (head.equals(BUNDLE_MAGIC_V1)) {
    throw new TransitionError(
      "This backup uses the retired v1 encryption format, which Vision no longer restores.",
      { hint: "Use a backup that Vision 2.0 made (encrypted backups from 2.0 start with VISIONBAK2)." },
    );
  }
  if (RAW_BACKUP_MAGICS.some((magic) => head.equals(magic))) {
    throw new TransitionError("This is an encrypted raw database backup (.sql.enc), not a .visionbak bundle.", {
      hint: "Use the .visionbak or .visionbak.enc file Vision 2.0 wrote (Settings > Backups).",
    });
  }
  throw new TransitionError("This file is neither a .visionbak bundle nor an encrypted .visionbak.enc bundle.", {
    hint: "Check that you passed the backup file itself.",
  });
}

function isAuthenticationFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    /unable to authenticate|bad decrypt|unsupported state/i.test(err.message) ||
    code === "ERR_OSSL_BAD_DECRYPT" ||
    code === "ERR_CRYPTO_INVALID_AUTH_TAG"
  );
}

/**
 * Decrypt a VISIONBAK2 file into `destination` (created, never overwritten,
 * mode 0600). A wrong passphrase and a changed byte both fail GCM
 * authentication; they cannot be told apart, and the message says so.
 */
export async function decryptBundle(source: string, destination: string, passphrase: string): Promise<void> {
  if (passphrase === "") throw new TransitionError("The backup is encrypted and the passphrase is empty.");
  const { size } = await fs.promises.stat(source);
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new TransitionError("The encrypted backup is truncated (shorter than its header).");
  }
  const header = await readAt(source, 0, HEADER_BYTES);
  const tag = await readAt(source, size - TAG_BYTES, TAG_BYTES);
  if (header.length !== HEADER_BYTES || tag.length !== TAG_BYTES) {
    throw new TransitionError("Could not read the encrypted backup header.");
  }
  const salt = header.subarray(BUNDLE_MAGIC_V2.length, BUNDLE_MAGIC_V2.length + SALT_BYTES);
  const iv = header.subarray(BUNDLE_MAGIC_V2.length + SALT_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const cipherTextBytes = size - HEADER_BYTES - TAG_BYTES;
    if (cipherTextBytes === 0) throw new TransitionError("The encrypted backup holds no data.");
    const input = fs.createReadStream(source, { start: HEADER_BYTES, end: HEADER_BYTES + cipherTextBytes - 1 });
    const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(input, decipher, output);
    } catch (err) {
      await fs.promises.rm(destination, { force: true });
      if (isAuthenticationFailure(err)) {
        throw new TransitionError(
          "The backup could not be decrypted: wrong passphrase, or the file was changed or damaged " +
            "(AES-GCM authentication failed).",
          {
            hint:
              "Check the passphrase (it is the backup passphrase set in Vision 2.0, case and spaces included). " +
              "If it is right, the file is damaged: use another copy of the backup.",
          },
        );
      }
      throw err;
    }
    const handle = await fs.promises.open(destination, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    key.fill(0);
  }
}

/** Encrypt `source` as a VISIONBAK2 file at `destination` (created, never overwritten). */
export async function encryptBundle(source: string, destination: string, passphrase: string): Promise<void> {
  if (passphrase === "") throw new TransitionError("Encryption requires a passphrase.");
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const handle = await fs.promises.open(destination, "wx", 0o600);
    try {
      await handle.write(Buffer.concat([BUNDLE_MAGIC_V2, salt, iv]));
      for await (const chunk of fs.createReadStream(source)) {
        const out = cipher.update(chunk as Buffer);
        if (out.length > 0) await handle.write(out);
      }
      const last = cipher.final();
      if (last.length > 0) await handle.write(last);
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } catch (err) {
      await handle.close();
      await fs.promises.rm(destination, { force: true });
      throw err;
    }
    await handle.close();
  } finally {
    key.fill(0);
  }
}
