"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  decryptFile,
  encryptFileV2,
  isEncryptedFile,
} = require("./encrypted-file");

const PASSPHRASE = "fixture-pass";
const PLAINTEXT = Buffer.from("Vision backup fixture\nline 2\n");
const RAW_V1 = Buffer.from("VISIONENC1");
const RAW_V2 = Buffer.from("VISIONENC2");
const BUNDLE_V1 = Buffer.from("VISIONBAK1");
const BUNDLE_V2 = Buffer.from("VISIONBAK2");

// These fixtures were produced by the released formats, independently of the
// implementation under test. Fixed bytes protect restore compatibility.
const FIXTURES = {
  rawV1:
    "564953494f4e454e4331000102030405060708090a0b0c0d0e0f9413238b7868de05da197343316234004b38f551fcd147a323d959763a016e6a",
  bundleV1:
    "564953494f4e42414b31000102030405060708090a0b0c0d0e0f9413238b7868de05da197343316234004b38f551fcd147a323d959763a016e6a",
  rawV2:
    "564953494f4e454e4332101112131415161718191a1b1c1d1e1f202122232425262728292a2bbd9495463b5f7bc5ffe64f413139d351365637cf70df5ba6862a7887fda8f510ddc61336d088aff162cd4ca0e7",
  bundleV2:
    "564953494f4e42414b32101112131415161718191a1b1c1d1e1f202122232425262728292a2bbd9495463b5f7bc5ffe64f413139d351365637cf70df5ba6862a7887fda8f510ddc61336d088aff162cd4ca0e7",
};

function configuration(kind) {
  const bundle = kind.startsWith("bundle");
  return {
    v1Magic: bundle ? BUNDLE_V1 : RAW_V1,
    v2Magic: bundle ? BUNDLE_V2 : RAW_V2,
    v1Salt: "vision-backup-v1",
    requiredError: "PASSPHRASE_REQUIRED",
    invalidError: "INVALID_PASSPHRASE",
    invalidHeaderMessage: "INVALID_HEADER",
    unsupportedFormatMessage: "UNSUPPORTED_FORMAT",
  };
}

async function withTempDir(run) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-encrypted-file-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

for (const [kind, hex] of Object.entries(FIXTURES)) {
  test(`decrypts the fixed ${kind} fixture`, async () => {
    await withTempDir(async (directory) => {
      const encryptedPath = path.join(directory, `${kind}.enc`);
      const destinationPath = path.join(directory, `${kind}.out`);
      await fs.promises.writeFile(encryptedPath, Buffer.from(hex, "hex"));

      await decryptFile({
        encryptedPath,
        destinationPath,
        keyOrPassphrase: PASSPHRASE,
        ...configuration(kind),
      });

      assert.deepEqual(await fs.promises.readFile(destinationPath), PLAINTEXT);
    });
  });
}

test("recognises both format generations without accepting arbitrary files", async () => {
  await withTempDir(async (directory) => {
    const v1Path = path.join(directory, "v1.enc");
    const v2Path = path.join(directory, "v2.enc");
    const plainPath = path.join(directory, "plain.txt");
    await Promise.all([
      fs.promises.writeFile(v1Path, Buffer.from(FIXTURES.rawV1, "hex")),
      fs.promises.writeFile(v2Path, Buffer.from(FIXTURES.rawV2, "hex")),
      fs.promises.writeFile(plainPath, PLAINTEXT),
    ]);

    assert.equal(await isEncryptedFile(v1Path, [RAW_V1, RAW_V2]), true);
    assert.equal(await isEncryptedFile(v2Path, [RAW_V1, RAW_V2]), true);
    assert.equal(await isEncryptedFile(plainPath, [RAW_V1, RAW_V2]), false);
  });
});

test("new v2 files round-trip with the requested magic", async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, "source.sql");
    const encryptedPath = path.join(directory, "source.sql.enc");
    const destinationPath = path.join(directory, "restored.sql");
    await fs.promises.writeFile(sourcePath, PLAINTEXT);

    await encryptFileV2(sourcePath, encryptedPath, PASSPHRASE, RAW_V2);
    const encrypted = await fs.promises.readFile(encryptedPath);
    assert.deepEqual(encrypted.subarray(0, RAW_V2.length), RAW_V2);

    await decryptFile({
      encryptedPath,
      destinationPath,
      keyOrPassphrase: PASSPHRASE,
      ...configuration("rawV2"),
    });
    assert.deepEqual(await fs.promises.readFile(destinationPath), PLAINTEXT);
  });
});

test("authentication failures remove the partial plaintext", async () => {
  await withTempDir(async (directory) => {
    const encryptedPath = path.join(directory, "wrong-pass.enc");
    const destinationPath = path.join(directory, "partial.sql");
    await fs.promises.writeFile(
      encryptedPath,
      Buffer.from(FIXTURES.rawV2, "hex"),
    );

    await assert.rejects(
      decryptFile({
        encryptedPath,
        destinationPath,
        keyOrPassphrase: "wrong-passphrase",
        ...configuration("rawV2"),
      }),
      /INVALID_PASSPHRASE/,
    );
    assert.equal(fs.existsSync(destinationPath), false);
  });
});

test("authentication failure waits for the output stream to close before cleanup", async () => {
  await withTempDir(async (directory) => {
    const encryptedPath = path.join(directory, "ordered-cleanup.enc");
    const destinationPath = path.join(directory, "partial.sql");
    await fs.promises.writeFile(
      encryptedPath,
      Buffer.from(FIXTURES.rawV2, "hex"),
    );

    const originalCreateWriteStream = fs.createWriteStream;
    const originalUnlink = fs.unlink;
    let output;
    let closedWhenUnlinked = false;
    fs.createWriteStream = (...args) => {
      output = originalCreateWriteStream(...args);
      return output;
    };
    fs.unlink = (filePath, callback) => {
      closedWhenUnlinked = output?.closed === true;
      originalUnlink(filePath, callback);
    };
    try {
      await assert.rejects(
        decryptFile({
          encryptedPath,
          destinationPath,
          keyOrPassphrase: "wrong-passphrase",
          ...configuration("rawV2"),
        }),
        /INVALID_PASSPHRASE/,
      );
    } finally {
      fs.createWriteStream = originalCreateWriteStream;
      fs.unlink = originalUnlink;
    }

    assert.equal(closedWhenUnlinked, true);
    assert.equal(fs.existsSync(destinationPath), false);
  });
});

test("truncated authenticated files fail before creating plaintext", async () => {
  await withTempDir(async (directory) => {
    const encryptedPath = path.join(directory, "truncated.enc");
    const destinationPath = path.join(directory, "partial.sql");
    await fs.promises.writeFile(
      encryptedPath,
      Buffer.from(FIXTURES.bundleV2, "hex").subarray(0, 30),
    );

    await assert.rejects(
      decryptFile({
        encryptedPath,
        destinationPath,
        keyOrPassphrase: PASSPHRASE,
        ...configuration("bundleV2"),
      }),
      /INVALID_HEADER/,
    );
    assert.equal(fs.existsSync(destinationPath), false);
  });
});
