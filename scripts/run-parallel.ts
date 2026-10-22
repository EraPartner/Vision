#!/usr/bin/env bun
/**
 * Run shell commands in parallel (ADR-245; replaces `concurrently`).
 *
 *   bun scripts/run-parallel.ts [--group] [--kill-others-on-fail] name=command ...
 *
 * Default output is line-prefixed with `[name]` as it arrives. `--group`
 * buffers each command's output and prints it in argument order, as if the
 * commands ran one after another. `--kill-others-on-fail` stops the rest when
 * one fails. The exit code is 1 when any command failed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

export interface Task {
  name: string;
  command: string;
}

export interface Options {
  group: boolean;
  killOthersOnFail: boolean;
  tasks: Task[];
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { group: false, killOthersOnFail: false, tasks: [] };
  for (const arg of argv) {
    if (arg === "--group") options.group = true;
    else if (arg === "--kill-others-on-fail") options.killOthersOnFail = true;
    else {
      const split = arg.indexOf("=");
      if (split <= 0 || arg.startsWith("-"))
        throw new Error(`expected name=command, got ${JSON.stringify(arg)}`);
      options.tasks.push({
        name: arg.slice(0, split),
        command: arg.slice(split + 1),
      });
    }
  }
  if (options.tasks.length === 0) throw new Error("no commands given");
  return options;
}

function prefixLines(name: string, write: (text: string) => void) {
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) write(`[${name}] ${line}\n`);
    },
    flush() {
      if (pending !== "") write(`[${name}] ${pending}\n`);
      pending = "";
    },
  };
}

export async function run(options: Options): Promise<number> {
  const children: ChildProcess[] = [];
  let stopping = false;
  const stopOthers = () => {
    stopping = true;
    for (const child of children) {
      if (child.exitCode !== null || child.pid === undefined) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
  const results = options.tasks.map(
    (task) =>
      new Promise<{ task: Task; code: number; output: string }>((resolve) => {
        const child = spawn("sh", ["-c", task.command], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
        });
        children.push(child);
        let output = "";
        const out = prefixLines(task.name, (text) => process.stdout.write(text));
        const onData = (chunk: Buffer) => {
          if (options.group) output += chunk.toString();
          else out.push(chunk.toString());
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          output += `${error.message}\n`;
        });
        child.on("close", (code, signal) => {
          out.flush();
          const exit = code ?? (signal ? 1 : 0);
          if (exit !== 0 && options.killOthersOnFail && !stopping) stopOthers();
          resolve({ task, code: exit, output });
        });
      }),
  );
  const settled = await Promise.all(results);
  for (const { task, code, output } of settled) {
    if (options.group) {
      process.stdout.write(`[${task.name}] ${task.command}\n${output}`);
      if (output !== "" && !output.endsWith("\n")) process.stdout.write("\n");
    }
    process.stdout.write(`[${task.name}] exited with code ${code}\n`);
  }
  return settled.some((result) => result.code !== 0) ? 1 : 0;
}

if (isEntrypoint(import.meta)) {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`run-parallel: ${(error as Error).message}`);
    process.exit(2);
  }
  process.exit(await run(options));
}
