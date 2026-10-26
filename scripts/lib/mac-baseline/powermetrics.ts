/**
 * `sudo powermetrics -f plist` for the Mac performance baseline: a small XML
 * plist parser, per-sample extraction, and summaries over time windows.
 *
 * Key names differ between macOS releases and chips, so extraction tries
 * several spellings and every sample's raw processor/gpu dictionaries are kept
 * in powermetrics.jsonl for re-parsing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

export type PlistValue =
  string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

type Token =
  | { kind: "open" | "close" | "empty"; name: string }
  | { kind: "text"; value: string };

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, e: string) => {
      const lower = e.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return String.fromCodePoint(code);
    },
  );
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  // The first alternative consumes the XML prolog, DOCTYPE and comments,
  // which carry no plist values and are skipped in place.
  const re =
    /(<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>)|<(\/?)([A-Za-z_][\w-]*)[^>]*?(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(re)) {
    const [, skipped, slash, name, selfClose, text] = match;
    if (skipped !== undefined) continue;
    if (text !== undefined) {
      tokens.push({ kind: "text", value: decodeEntities(text) });
    } else if (slash) {
      tokens.push({ kind: "close", name: name ?? "" });
    } else {
      tokens.push({ kind: selfClose ? "empty" : "open", name: name ?? "" });
    }
  }
  return tokens;
}

/** Parse one XML property list document. */
export function parsePlist(xml: string): PlistValue {
  const tokens = tokenize(xml);
  let index = 0;
  const nextTag = (): Token => {
    while (index < tokens.length) {
      const token = tokens[index++] as Token;
      if (token.kind !== "text" || token.value.trim() !== "") return token;
    }
    throw new Error("Unexpected end of plist");
  };
  const readText = (name: string): string => {
    let text = "";
    for (;;) {
      const token = tokens[index++];
      if (!token) throw new Error(`Unclosed <${name}>`);
      if (token.kind === "text") text += token.value;
      else if (token.kind === "close" && token.name === name) return text;
      else throw new Error(`Unexpected <${token.name}> inside <${name}>`);
    }
  };
  const parseValue = (token: Token): PlistValue => {
    if (token.kind === "text" || token.kind === "close") {
      throw new Error("Expected a plist value");
    }
    if (token.kind === "empty") {
      if (token.name === "true") return true;
      if (token.name === "false") return false;
      if (token.name === "dict") return {};
      if (token.name === "array") return [];
      return "";
    }
    switch (token.name) {
      case "plist": {
        const value = parseValue(nextTag());
        nextTag(); // </plist>
        return value;
      }
      case "dict": {
        const dict: { [key: string]: PlistValue } = {};
        for (;;) {
          const keyToken = nextTag();
          if (keyToken.kind === "close" && keyToken.name === "dict")
            return dict;
          if (keyToken.kind !== "open" || keyToken.name !== "key") {
            throw new Error("Expected <key> in <dict>");
          }
          const key = readText("key");
          dict[key] = parseValue(nextTag());
        }
      }
      case "array": {
        const array: PlistValue[] = [];
        for (;;) {
          const item = nextTag();
          if (item.kind === "close" && item.name === "array") return array;
          array.push(parseValue(item));
        }
      }
      case "integer":
      case "real":
        return Number(readText(token.name).trim());
      case "true":
      case "false": {
        readText(token.name);
        return token.name === "true";
      }
      default:
        // string, date, data: keep the text.
        return readText(token.name);
    }
  };
  return parseValue(nextTag());
}

type Dict = { [key: string]: PlistValue };
const isDict = (value: PlistValue | undefined): value is Dict =>
  typeof value === "object" && !Array.isArray(value);
const num = (dict: Dict | undefined, ...keys: string[]): number | null => {
  if (!dict) return null;
  for (const key of keys) {
    const value = dict[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

export interface TaskSample {
  pid: number;
  name: string;
  cpuMsPerS: number | null;
  gpuMsPerS: number | null;
  energyImpactPerS: number | null;
}

export interface PowerSample {
  /** Wall-clock ms when the sample arrived (end of its interval). */
  receivedAt: number;
  elapsedMs: number | null;
  cpuPowerMw: number | null;
  gpuPowerMw: number | null;
  anePowerMw: number | null;
  combinedPowerMw: number | null;
  gpuFreqMhz: number | null;
  gpuActivePercent: number | null;
  thermalPressure: string | null;
  tasks: TaskSample[];
}

/** Process names kept from the tasks sampler. */
export const TASK_NAME_FILTER =
  /(^|[^a-z])vision|postgres|ollama|llama|windowserver|electron/i;

/** Power in mW from a `*_power` key, else from `*_energy` (mJ) over the interval. */
function power(
  dicts: (Dict | undefined)[],
  name: string,
  elapsedSeconds: number | null,
): number | null {
  for (const dict of dicts) {
    const direct = num(dict, `${name}_power`, `${name}_power_mw`);
    if (direct !== null) return direct;
  }
  if (elapsedSeconds !== null && elapsedSeconds > 0) {
    for (const dict of dicts) {
      const energy = num(dict, `${name}_energy`);
      if (energy !== null) return energy / elapsedSeconds;
    }
  }
  return null;
}

export function extractSample(
  sample: PlistValue,
  receivedAt: number,
  taskFilter: RegExp = TASK_NAME_FILTER,
): PowerSample {
  const root = isDict(sample) ? sample : {};
  const processor = isDict(root.processor) ? root.processor : undefined;
  const gpu = isDict(root.gpu) ? root.gpu : undefined;
  const elapsedNs = num(root, "elapsed_ns");
  const elapsedSeconds = elapsedNs === null ? null : elapsedNs / 1e9;
  const idleRatio = num(gpu, "idle_ratio");
  const gpuFreqMhz = activeGpuFrequency(gpu);
  const tasks: TaskSample[] = [];
  if (Array.isArray(root.tasks)) {
    for (const task of root.tasks) {
      if (!isDict(task)) continue;
      const name = typeof task.name === "string" ? task.name : "";
      if (!taskFilter.test(name)) continue;
      const gpuNs = num(task, "gputime_ns");
      tasks.push({
        pid: num(task, "pid") ?? -1,
        name,
        cpuMsPerS: num(task, "cputime_ms_per_s"),
        gpuMsPerS:
          num(task, "gputime_ms_per_s", "gpu_ms_per_s") ??
          (gpuNs !== null && elapsedSeconds !== null && elapsedSeconds !== 0
            ? gpuNs / 1e6 / elapsedSeconds
            : null),
        energyImpactPerS: num(task, "energy_impact_per_s"),
      });
    }
  }
  return {
    receivedAt,
    elapsedMs: elapsedNs === null ? null : elapsedNs / 1e6,
    cpuPowerMw: power([processor], "cpu", elapsedSeconds),
    gpuPowerMw: power([processor, gpu], "gpu", elapsedSeconds),
    anePowerMw: power([processor], "ane", elapsedSeconds),
    combinedPowerMw:
      num(processor, "combined_power", "package_power") ??
      power([processor], "package", elapsedSeconds),
    gpuFreqMhz,
    gpuActivePercent: idleRatio === null ? null : (1 - idleRatio) * 100,
    thermalPressure:
      typeof root.thermal_pressure === "string" ? root.thermal_pressure : null,
    tasks,
  };
}

/**
 * Mean GPU frequency while active (MHz), from the residency per DVFM state.
 * `gpu.freq_hz` is averaged over idle time too, and macOS 27 reports it in
 * MHz despite its name, so it is only the fallback.
 */
function activeGpuFrequency(gpu: Dict | undefined): number | null {
  if (gpu && Array.isArray(gpu.dvfm_states)) {
    let weighted = 0;
    let used = 0;
    for (const state of gpu.dvfm_states) {
      if (!isDict(state)) continue;
      const freq = num(state, "freq");
      const ratio = num(state, "used_ratio");
      if (freq === null || ratio === null) continue;
      weighted += freq * ratio;
      used += ratio;
    }
    if (used > 0) return weighted / used;
  }
  const freq = num(gpu, "freq_hz");
  if (freq === null || freq === 0) return null;
  return freq > 100_000 ? freq / 1e6 : freq;
}

/** Split a growing plist stream into complete documents; returns the rest. */
export function splitPlistDocuments(buffer: string): {
  documents: string[];
  rest: string;
} {
  const documents: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("</plist>");
    if (end < 0) break;
    const doc = rest.slice(0, end + "</plist>".length).replace(/^[\s\0]+/, "");
    if (doc) documents.push(doc);
    rest = rest.slice(end + "</plist>".length);
  }
  return { documents, rest };
}

export interface PowerSummary {
  samples: number;
  cpuPowerMw: number | null;
  gpuPowerMw: number | null;
  anePowerMw: number | null;
  combinedPowerMw: number | null;
  gpuFreqMhz: number | null;
  gpuActivePercent: number | null;
  gpuActivePercentMax: number | null;
  thermalPressure: Record<string, number>;
  /** Mean per-second values per process name (summed over same-name processes). */
  tasks: Record<
    string,
    {
      cpuMsPerS: number | null;
      gpuMsPerS: number | null;
      energyImpactPerS: number | null;
    }
  >;
}

const mean = (values: (number | null)[]): number | null => {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return (
    Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10
  );
};

/** Samples whose whole interval falls inside [start, end] (ms, wall clock). */
export function samplesBetween(
  samples: readonly PowerSample[],
  start: number,
  end: number,
): PowerSample[] {
  return samples.filter((sample) => {
    const begin = sample.receivedAt - (sample.elapsedMs ?? 1000);
    return begin >= start - 150 && sample.receivedAt <= end + 300;
  });
}

export function summarizePower(samples: readonly PowerSample[]): PowerSummary {
  const thermalPressure: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.thermalPressure ?? "unknown";
    thermalPressure[key] = (thermalPressure[key] ?? 0) + 1;
  }
  const perName = new Map<
    string,
    {
      cpu: (number | null)[];
      gpu: (number | null)[];
      energy: (number | null)[];
    }
  >();
  for (const sample of samples) {
    const totals = new Map<
      string,
      { cpu: number | null; gpu: number | null; energy: number | null }
    >();
    for (const task of sample.tasks) {
      const total = totals.get(task.name) ?? {
        cpu: null,
        gpu: null,
        energy: null,
      };
      const plus = (a: number | null, b: number | null) =>
        b === null ? a : (a ?? 0) + b;
      total.cpu = plus(total.cpu, task.cpuMsPerS);
      total.gpu = plus(total.gpu, task.gpuMsPerS);
      total.energy = plus(total.energy, task.energyImpactPerS);
      totals.set(task.name, total);
    }
    for (const [name, total] of totals) {
      const series = perName.get(name) ?? { cpu: [], gpu: [], energy: [] };
      series.cpu.push(total.cpu);
      series.gpu.push(total.gpu);
      series.energy.push(total.energy);
      perName.set(name, series);
    }
  }
  const tasks: PowerSummary["tasks"] = {};
  for (const [name, series] of perName) {
    tasks[name] = {
      cpuMsPerS: mean(series.cpu),
      gpuMsPerS: mean(series.gpu),
      energyImpactPerS: mean(series.energy),
    };
  }
  const active = samples
    .map((sample) => sample.gpuActivePercent)
    .filter((value): value is number => value !== null);
  return {
    samples: samples.length,
    cpuPowerMw: mean(samples.map((s) => s.cpuPowerMw)),
    gpuPowerMw: mean(samples.map((s) => s.gpuPowerMw)),
    anePowerMw: mean(samples.map((s) => s.anePowerMw)),
    combinedPowerMw: mean(samples.map((s) => s.combinedPowerMw)),
    gpuFreqMhz: mean(samples.map((s) => s.gpuFreqMhz)),
    gpuActivePercent: mean(samples.map((s) => s.gpuActivePercent)),
    gpuActivePercentMax:
      active.length > 0 ? Math.round(Math.max(...active) * 10) / 10 : null,
    thermalPressure,
    tasks,
  };
}

/**
 * One `sudo -n powermetrics` for the whole run (sudo is validated up front so
 * nothing prompts mid-run). Samples land in memory and in a JSONL file.
 */
export class PowermetricsRecorder {
  readonly samples: PowerSample[] = [];
  readonly keysSeen = new Set<string>();
  private child: ChildProcess | undefined;
  private buffer = "";
  private parseErrors = 0;
  private stderr = "";

  private readonly jsonlPath: string;
  private readonly intervalMs: number;

  constructor(jsonlPath: string, intervalMs = 1000) {
    this.jsonlPath = jsonlPath;
    this.intervalMs = intervalMs;
  }

  start(): void {
    const out = fs.createWriteStream(this.jsonlPath, { flags: "a" });
    this.child = spawn(
      "sudo",
      [
        "-n",
        "powermetrics",
        "--samplers",
        "cpu_power,gpu_power,thermal,tasks",
        "--show-process-gpu",
        "--show-process-energy",
        "-i",
        String(this.intervalMs),
        "-f",
        "plist",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      const { documents, rest } = splitPlistDocuments(this.buffer + chunk);
      this.buffer = rest;
      const receivedAt = Date.now();
      for (const document of documents) {
        try {
          const parsed = parsePlist(document);
          if (isDict(parsed)) {
            for (const key of Object.keys(parsed)) this.keysSeen.add(key);
            for (const nested of ["processor", "gpu"] as const) {
              const dict = parsed[nested];
              if (isDict(dict)) {
                for (const key of Object.keys(dict))
                  this.keysSeen.add(`${nested}.${key}`);
              }
            }
            if (Array.isArray(parsed.tasks)) {
              for (const task of parsed.tasks) {
                if (!isDict(task)) continue;
                for (const key of Object.keys(task))
                  this.keysSeen.add(`tasks[].${key}`);
              }
            }
          }
          const sample = extractSample(parsed, receivedAt);
          this.samples.push(sample);
          const raw = isDict(parsed)
            ? {
                processor: stripClusters(parsed.processor),
                gpu: parsed.gpu,
                thermal_pressure: parsed.thermal_pressure,
                elapsed_ns: parsed.elapsed_ns,
                // Full task list for the first samples, so task key names
                // and process naming can be checked after a run.
                ...(this.samples.length <= 5
                  ? { tasks: parsed.tasks, all_tasks: parsed.all_tasks }
                  : {}),
              }
            : null;
          out.write(`${JSON.stringify({ ...sample, raw })}\n`);
        } catch {
          this.parseErrors += 1;
        }
      }
    });
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  status(): {
    samples: number;
    parseErrors: number;
    stderr: string;
    keysSeen: string[];
  } {
    return {
      samples: this.samples.length,
      parseErrors: this.parseErrors,
      stderr: this.stderr.trim(),
      keysSeen: [...this.keysSeen].sort(),
    };
  }

  summarize(start: number, end: number): PowerSummary | null {
    const window = samplesBetween(this.samples, start, end);
    return window.length > 0 ? summarizePower(window) : null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    // sudo relays the signal to powermetrics.
    child.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Per-core arrays make the processor dict large; keep cluster totals only. */
function stripClusters(value: PlistValue | undefined): PlistValue | undefined {
  if (!isDict(value)) return value;
  const copy: Dict = { ...value };
  if (Array.isArray(copy.clusters)) {
    copy.clusters = copy.clusters.map((cluster) => {
      if (!isDict(cluster)) return cluster;
      const { cpus: _cpus, ...rest } = cluster;
      return rest;
    });
  }
  return copy;
}
