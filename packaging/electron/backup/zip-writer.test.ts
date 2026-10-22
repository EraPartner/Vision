import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Yauzl from "yauzl";
import { crc32, createZipWriter } from "./zip-writer";

const yauzl: typeof Yauzl = require("yauzl");

interface ReadEntry {
  name: string;
  flags: number;
  method: number;
  mode: string;
  data: Buffer;
}

/** Read every entry with yauzl, the reader restore uses. */
function readZip(zipPath: string): Promise<ReadEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries: ReadEntry[] = [];
      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(entries));
      zipfile.on("entry", (entry: Yauzl.Entry) => {
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.push({
              name: entry.fileName,
              flags: entry.generalPurposeBitFlag,
              method: entry.compressionMethod,
              mode: (entry.externalFileAttributes >>> 16).toString(8),
              data: Buffer.concat(chunks),
            });
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-zip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function attachmentTree(root: string) {
  const random = crypto.randomBytes(200_000);
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.mkdirSync(path.join(root, "empty"));
  fs.writeFileSync(path.join(root, "top.txt"), "hi\n");
  fs.writeFileSync(path.join(root, "a", "b", "bin.dat"), random);
  fs.writeFileSync(path.join(root, "a", "nothing.txt"), "");
  fs.writeFileSync(path.join(root, "été.txt"), "x\n");
  fs.symlinkSync("../top.txt", path.join(root, "a", "link.txt"));
  return random;
}

for (const forceZip64 of [false, true]) {
  test(`round-trips a bundle-shaped archive through yauzl (zip64: ${forceZip64})`, async (t) => {
    const dir = tempDir(t);
    const attachments = path.join(dir, "att");
    const random = attachmentTree(attachments);
    const sql = "SELECT 1;\n".repeat(10_000);
    fs.writeFileSync(path.join(dir, "db.sql"), sql);
    const zipPath = path.join(dir, "out.zip");

    const zip = await createZipWriter(zipPath, { forceZip64 });
    await zip.append("metadata.json", JSON.stringify({ bundleVersion: 1 }));
    await zip.file(path.join(dir, "db.sql"), "db.sql");
    await zip.directory(attachments, "attachments");
    await zip.append("frontend-state.json", "");
    await zip.finalize();

    const entries = await readZip(zipPath);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      [
        "metadata.json",
        "db.sql",
        "attachments/a/",
        "attachments/a/b/",
        "attachments/a/b/bin.dat",
        "attachments/a/link.txt",
        "attachments/a/nothing.txt",
        "attachments/empty/",
        "attachments/top.txt",
        "attachments/été.txt",
        "frontend-state.json",
      ],
    );
    assert.equal(byName.get("db.sql")?.data.toString(), sql);
    assert.ok(byName.get("attachments/a/b/bin.dat")?.data.equals(random));
    assert.equal(byName.get("attachments/a/nothing.txt")?.data.length, 0);
    assert.equal(byName.get("frontend-state.json")?.data.length, 0);
    assert.equal(byName.get("metadata.json")?.mode, "100644");
    // Same layout archiver wrote: directories and symlinks stored, the
    // symlink's target as its content, UTF-8 flag only on non-ASCII names.
    assert.equal(byName.get("attachments/a/")?.method, 0);
    assert.match(byName.get("attachments/a/")?.mode ?? "", /^40/);
    assert.equal(byName.get("attachments/a/link.txt")?.data.toString(), "../top.txt");
    assert.match(byName.get("attachments/a/link.txt")?.mode ?? "", /^120/);
    assert.equal(byName.get("attachments/top.txt")?.method, 8);
    assert.equal(byName.get("attachments/top.txt")?.flags, 0);
    assert.equal(byName.get("attachments/été.txt")?.flags, 0x800);

    // Info-ZIP checks every CRC and size when it is installed (macOS has it).
    const unzip = spawnSync("unzip", ["-tq", zipPath], { encoding: "utf8" });
    if (unzip.error === undefined) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  });
}

test("computes the standard CRC-32", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("6789"), crc32(Buffer.from("12345"))), 0xcbf43926);
});

test("rejects unsafe entry names and missing sources", async (t) => {
  const dir = tempDir(t);
  const zip = await createZipWriter(path.join(dir, "bad.zip"));
  await assert.rejects(zip.append("/etc/passwd", "x"), /Invalid zip entry name/);
  await assert.rejects(zip.append("a\\b", "x"), /Invalid zip entry name/);
  await assert.rejects(zip.file(path.join(dir, "missing.sql"), "db.sql"), /ENOENT/);
  await zip.abort();
});
