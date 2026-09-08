"use strict";

const crypto = require("crypto");
const fs = require("fs");

const V1_IV_BYTES = 16;
const V2_SALT_BYTES = 16;
const V2_IV_BYTES = 12;
const V2_TAG_BYTES = 16;
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;

function deriveKeyV1(passphrase, salt) {
  if (!passphrase || typeof passphrase !== "string") return null;
  return crypto.scryptSync(passphrase, salt, 32);
}

function deriveKeyV2(passphrase, salt) {
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

async function readMagic(filePath, magicLength, invalidHeaderMessage) {
  const magic = Buffer.alloc(magicLength);
  let handle;
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

async function isEncryptedFile(filePath, magics) {
  try {
    const magic = await readMagic(
      filePath,
      magics[0].length,
      "Invalid encrypted file header.",
    );
    return magics.some((candidate) => magic.equals(candidate));
  } catch {
    return false;
  }
}

function removePartialFile(cleanupPath, callback) {
  fs.unlink(cleanupPath, (err) => {
    if (err && err.code !== "ENOENT") {
      callback(err);
      return;
    }
    callback();
  });
}

function pipeCipher(input, cipher, output, cleanupPath, appendAuthTag = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      const rejectAfterCleanup = () => {
        removePartialFile(cleanupPath, (cleanupError) => {
          if (cleanupError && err && typeof err === "object") {
            err.cleanupError = cleanupError;
          }
          reject(err);
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
    input.pipe(cipher).pipe(output, { end: !appendAuthTag });
    if (appendAuthTag) {
      cipher.on("end", () => {
        try {
          output.end(cipher.getAuthTag());
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

async function encryptFileV2(sourcePath, destinationPath, passphrase, magic) {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("Encryption requires a passphrase.");
  }
  const salt = crypto.randomBytes(V2_SALT_BYTES);
  const iv = crypto.randomBytes(V2_IV_BYTES);
  const key = deriveKeyV2(passphrase, salt);
  try {
    const input = fs.createReadStream(sourcePath);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const output = fs.createWriteStream(destinationPath);
    output.write(magic);
    output.write(salt);
    output.write(iv);
    await pipeCipher(input, cipher, output, destinationPath, true);
  } finally {
    key.fill(0);
  }
}

function isAuthenticationFailure(err) {
  const message = err?.message ? String(err.message) : "";
  return (
    /unable to authenticate|bad decrypt|wrong final block|unsupported state/i.test(
      message,
    ) ||
    err?.code === "ERR_OSSL_BAD_DECRYPT" ||
    err?.code === "ERR_CRYPTO_INVALID_AUTH_TAG"
  );
}

async function decryptFile({
  encryptedPath,
  destinationPath,
  keyOrPassphrase,
  v1Magic,
  v2Magic,
  v1Salt,
  requiredError,
  invalidError,
  invalidHeaderMessage,
  unsupportedFormatMessage,
}) {
  if (!keyOrPassphrase) throw new Error(requiredError);
  const magic = await readMagic(
    encryptedPath,
    v1Magic.length,
    invalidHeaderMessage,
  );
  if (!magic.equals(v1Magic) && !magic.equals(v2Magic)) {
    throw new Error(unsupportedFormatMessage);
  }

  let key;
  try {
    if (magic.equals(v1Magic)) {
      key = Buffer.isBuffer(keyOrPassphrase)
        ? keyOrPassphrase
        : deriveKeyV1(keyOrPassphrase, v1Salt);
      if (!key) throw new Error(requiredError);
      const headerLength = v1Magic.length + V1_IV_BYTES;
      const header = Buffer.alloc(headerLength);
      let handle;
      try {
        handle = await fs.promises.open(encryptedPath, "r");
        const result = await handle.read(header, 0, headerLength, 0);
        if (result.bytesRead !== headerLength)
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
      const iv = header.subarray(v1Magic.length);
      await pipeCipher(
        fs.createReadStream(encryptedPath, { start: headerLength }),
        crypto.createDecipheriv("aes-256-cbc", key, iv),
        fs.createWriteStream(destinationPath),
        destinationPath,
      );
      return;
    }

    const headerLength = v2Magic.length + V2_SALT_BYTES + V2_IV_BYTES;
    const header = Buffer.alloc(headerLength);
    const tag = Buffer.alloc(V2_TAG_BYTES);
    let size;
    let handle;
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

module.exports = {
  V1_IV_BYTES,
  V2_SALT_BYTES,
  V2_IV_BYTES,
  V2_TAG_BYTES,
  deriveKeyV1,
  deriveKeyV2,
  isEncryptedFile,
  encryptFileV2,
  decryptFile,
};
