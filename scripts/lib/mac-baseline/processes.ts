/**
 * Process table parsing and role classification for the Mac performance
 * baseline. CPU % comes from cumulative CPU time deltas (exact over a window,
 * unlike ps's decaying %cpu); memory from ps RSS and top's MEM footprint.
 */

export interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuSeconds: number;
  command: string;
}

export type ProcessRole =
  | "main"
  | "renderer"
  | "gpu"
  | "network"
  | "utility"
  | "other"
  | "backend"
  | "postgres"
  | "ollama"
  | "windowserver";

/** Roles that belong to the Vision app itself (Ollama and WindowServer do not). */
export const APP_ROLES: readonly ProcessRole[] = [
  "main",
  "renderer",
  "gpu",
  "network",
  "utility",
  "other",
  "backend",
  "postgres",
];

export interface RoleRoots {
  mainPid: number;
  backendPid?: number | undefined;
  postgresPid?: number | undefined;
}

/** `ps -axww -o pid=,ppid=,rss=,time=,command=` → rows. */
export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, rss, time, command] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      cpuSeconds: parseCpuTime(time ?? ""),
      command: (command ?? "").trim(),
    });
  }
  return rows;
}

/**
 * Cumulative CPU time: macOS prints `[h:]mm:ss.ss` (minutes may pass 59),
 * procps prints `[DD-]hh:mm:ss`.
 */
export function parseCpuTime(value: string): number {
  let rest = value.trim();
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    return Number.NaN;
  }
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86_400 + seconds;
}

const MEM_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** top's MEM column value ("123M+", "1024K", "1.2G-") → bytes. */
export function parseMemValue(value: string): number | undefined {
  const match = /^([\d.]+)([BKMGT])[+-]?$/.exec(value.trim());
  if (!match) return undefined;
  const [, amount, unit] = match;
  const scale = MEM_UNITS[unit ?? ""];
  return scale === undefined ? undefined : Number(amount) * scale;
}

/** `top -l 1 -s 0 -stats pid,mem` → pid → footprint bytes. */
export function parseTopMem(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const bytes = parseMemValue(match[2] ?? "");
    if (bytes !== undefined) out.set(Number(match[1]), bytes);
  }
  return out;
}

function childrenMap(rows: readonly PsRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  return children;
}

function descendants(
  children: Map<number, number[]>,
  root: number,
): Set<number> {
  const seen = new Set<number>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return seen;
}

function chromiumRole(command: string): ProcessRole {
  const type = /--type=([\w-]+)/.exec(command)?.[1];
  if (type === "renderer") return "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "utility") {
    return /--utility-sub-type=network\./.test(command) ? "network" : "utility";
  }
  return "other";
}

const OLLAMA_RE =
  /(^|\/)ollama(\s|$)|\/Ollama\.app\/|ollama_llama_server|llama-server/i;

/** Map every pid we care about to a role; unrelated processes are left out. */
export function classifyProcesses(
  rows: readonly PsRow[],
  roots: RoleRoots,
): Map<number, ProcessRole> {
  const children = childrenMap(rows);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const roles = new Map<number, ProcessRole>();

  const postgres =
    roots.postgresPid !== undefined && byPid.has(roots.postgresPid)
      ? descendants(children, roots.postgresPid)
      : new Set<number>();
  const backend =
    roots.backendPid !== undefined && byPid.has(roots.backendPid)
      ? descendants(children, roots.backendPid)
      : new Set<number>();
  for (const pid of postgres) roles.set(pid, "postgres");
  for (const pid of backend) if (!roles.has(pid)) roles.set(pid, "backend");

  if (byPid.has(roots.mainPid)) {
    for (const pid of descendants(children, roots.mainPid)) {
      if (roles.has(pid)) continue;
      const command = byPid.get(pid)?.command ?? "";
      if (pid === roots.mainPid) roles.set(pid, "main");
      else if (/--type=/.test(command)) roles.set(pid, chromiumRole(command));
      // Without pid files, fall back to the executable names.
      else if (/\/postgres(\s|$)|^postgres:/.test(command))
        roles.set(pid, "postgres");
      else if (/vision-backend|\/bun(\s|$)/.test(command))
        roles.set(pid, "backend");
      else roles.set(pid, "other");
    }
  }

  for (const row of rows) {
    if (roles.has(row.pid)) continue;
    if (OLLAMA_RE.test(row.command)) {
      for (const pid of descendants(children, row.pid)) {
        if (!roles.has(pid)) roles.set(pid, "ollama");
      }
    } else if (/WindowServer/.test(row.command)) {
      roles.set(row.pid, "windowserver");
    }
  }
  return roles;
}

export interface RoleStats {
  processes: number;
  rssMb: number;
  footprintMb: number | null;
  cpuPercent: number | null;
}

export type RoleSummary = Partial<Record<ProcessRole | "appTotal", RoleStats>>;

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Per-role totals. `cpuPercent` is the CPU time spent per wall second over the
 * window ×100 (Activity Monitor's convention: 100% = one core), only when a
 * `before` snapshot is given.
 */
export function summarizeRoles(
  after: readonly PsRow[],
  roles: Map<number, ProcessRole>,
  options: {
    before?: readonly PsRow[] | undefined;
    wallSeconds?: number | undefined;
    footprints?: Map<number, number> | undefined;
  } = {},
): RoleSummary {
  const beforeCpu = new Map(
    (options.before ?? []).map((row) => [row.pid, row.cpuSeconds]),
  );
  const withCpu =
    options.before !== undefined &&
    options.wallSeconds !== undefined &&
    options.wallSeconds > 0;
  const summary: RoleSummary = {};
  const add = (key: ProcessRole | "appTotal", row: PsRow) => {
    const stats = summary[key] ?? {
      processes: 0,
      rssMb: 0,
      footprintMb: options.footprints ? 0 : null,
      cpuPercent: withCpu ? 0 : null,
    };
    stats.processes += 1;
    stats.rssMb += row.rssKb / 1024;
    const footprint = options.footprints?.get(row.pid);
    if (stats.footprintMb !== null) {
      stats.footprintMb += (footprint ?? row.rssKb * 1024) / 1024 ** 2;
    }
    if (stats.cpuPercent !== null && withCpu) {
      const start = beforeCpu.get(row.pid) ?? 0;
      const delta = Math.max(0, row.cpuSeconds - start);
      stats.cpuPercent += (delta / (options.wallSeconds as number)) * 100;
    }
    summary[key] = stats;
  };
  for (const row of after) {
    const role = roles.get(row.pid);
    if (!role) continue;
    add(role, row);
    if (APP_ROLES.includes(role)) add("appTotal", row);
  }
  for (const stats of Object.values(summary)) {
    stats.rssMb = round1(stats.rssMb);
    if (stats.footprintMb !== null)
      stats.footprintMb = round1(stats.footprintMb);
    if (stats.cpuPercent !== null) stats.cpuPercent = round1(stats.cpuPercent);
  }
  return summary;
}
