#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { __seatbeltProfile } from "../src/integrations/openai/brokerClient.js";

if (process.platform !== "darwin") {
  console.error("This smoke check requires macOS Seatbelt.");
  process.exitCode = 1;
} else {
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/integrations/openai/egress-helper.mjs",
  );
  const cwd = mkdtempSync(join(tmpdir(), "vision-openai-seatbelt-smoke-"));
  const outside = mkdtempSync(
    join(tmpdir(), "vision-openai-seatbelt-outside-"),
  );
  try {
    const outsideFile = join(outside, "synthetic.txt");
    const deniedWrite = join(cwd, "denied-write.txt");
    writeFileSync(outsideFile, "synthetic-only");
    const profile = __seatbeltProfile(process.execPath, helper, cwd);
    const run = (args, input = "") => {
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, process.execPath, ...args],
        {
          cwd,
          env: { OPENAI_API_KEY: "synthetic-key" },
          input,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 8_192,
        },
      );
      return {
        exitCode: result.status,
        signal: result.signal,
        response: result.stdout.trim(),
        diagnostic: result.stderr.trim().slice(0, 500),
        error: result.error?.code,
      };
    };
    const request = {
      body: JSON.stringify({
        model: "synthetic",
        input: "offline smoke check",
        store: true,
        background: false,
        tools: [],
      }),
      timeoutMs: 100,
    };
    const helperResult = run([helper], JSON.stringify(request));
    const readProbe = run([
      "-e",
      "try { require('node:fs').readFileSync(process.argv[1]); process.exit(2); } catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 3); }",
      outsideFile,
    ]);
    const writeProbe = run([
      "-e",
      "try { require('node:fs').writeFileSync(process.argv[1], 'x'); process.exit(2); } catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 3); }",
      deniedWrite,
    ]);
    const helperPassed =
      helperResult.exitCode === 0 &&
      helperResult.response === '{"ok":false,"code":"INVALID_BROKER_POLICY"}';
    const fileConfinementPassed =
      readProbe.exitCode === 0 &&
      writeProbe.exitCode === 0 &&
      !existsSync(deniedWrite);
    const passed = helperPassed && fileConfinementPassed;
    console.log(
      JSON.stringify({
        passed,
        helperPassed,
        fileConfinementPassed,
        helperResult,
        readProbe,
        writeProbe,
      }),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}
