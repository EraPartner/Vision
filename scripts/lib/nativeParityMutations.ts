/**
 * Mutated parity areas (ADR-270 decision 5): the recorded requests and provider
 * answers of the hand-written areas, changed at random by a seeded generator,
 * so the Swift replay meets inputs nobody chose by hand. The generator is
 * deterministic: the same seed gives the same steps, so the checked-in corpus
 * can be compared with what this module builds.
 */

/** The shape of a parity step and area, as native-parity.ts declares them. */
export interface MutationStep {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Provider answers from this step on, replacing the area's. */
  fetch?: Record<string, { status: number; body: string }>;
}

/** mulberry32: small, seeded and the same on every engine. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Text that exercises trimming, case folding, code-point length and escaping. */
const TEXT_PIECES = [
  "a",
  "Z",
  "0",
  "9",
  "-",
  "_",
  ".",
  " ",
  "  ",
  "\t",
  "\n",
  "\r\n",
  " ",
  " ",
  "　",
  "﻿",
  "é",
  "é",
  "İ",
  "ı",
  "ß",
  "K",
  "Ω",
  "🚀",
  "👍🏽",
  "中文",
  "\u0000",
  "\u001F",
  "\\",
  '"',
  "'",
  "/",
  "<",
  ">",
  "&",
  "%",
  "+",
  "#",
  "?",
  "=",
  ",",
  ";",
  ":",
  "{",
  "}",
  "[",
  "]",
  "true",
  "null",
  "NaN",
  "1e3",
  "0x1F",
  "-0",
  " 12 ",
  "1.5",
  "Infinity",
  "__proto__",
  "constructor",
];

export function randomText(random: Random, maxPieces = 6): string {
  let text = "";
  const count = random.int(maxPieces + 1);
  for (let i = 0; i < count; i++) text += random.pick(TEXT_PIECES);
  if (random.chance(0.05)) text = text.repeat(40 + random.int(80));
  return text;
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  0.1 + 0.2,
  1.5,
  2.5,
  7,
  24,
  25,
  50,
  99.99,
  100,
  100.0001,
  101,
  1000,
  1001,
  1e6,
  1e13,
  1e21,
  2 ** 53,
  2 ** 53 + 2,
  -(2 ** 31),
  1e-7,
  5e-324,
  1.7976931348623157e308,
  1899,
  1900,
  2024,
  2100,
  2101,
];

/** A JSON value of any kind; `depth` bounds nesting. */
export function randomValue(random: Random, depth = 2): unknown {
  const kind = random.int(depth > 0 ? 8 : 6);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return random.chance(0.5);
    case 2:
    case 3:
      return random.pick(NUMBERS);
    case 4:
    case 5:
      return random.chance(0.3)
        ? String(random.pick(NUMBERS))
        : randomText(random);
    case 6: {
      const items: unknown[] = [];
      const count = random.int(4);
      for (let i = 0; i < count; i++)
        items.push(randomValue(random, depth - 1));
      return items;
    }
    default: {
      const object: Record<string, unknown> = {};
      const count = random.int(4);
      for (let i = 0; i < count; i++)
        object[randomKey(random)] = randomValue(random, depth - 1);
      return object;
    }
  }
}

function randomKey(random: Random): string {
  return random.pick([
    "a",
    "b",
    "id",
    "value",
    "kind",
    "name",
    "2",
    "10",
    "",
    "__proto__",
    "x y",
    "é",
  ]);
}

/** A copy of `value` with one change at a random place: replace, drop, add, retype or nudge. */
export function mutate(random: Random, value: unknown): unknown {
  if (Array.isArray(value)) {
    const copy: unknown[] = [...(value as unknown[])];
    const action = random.int(copy.length === 0 ? 2 : 6);
    if (action === 0) copy.push(randomValue(random));
    else if (action === 1) return randomValue(random);
    else if (action === 2) copy.splice(random.int(copy.length), 1);
    else if (action === 3)
      copy.push(structuredClone(copy[random.int(copy.length)]));
    else {
      const index = random.int(copy.length);
      copy[index] = mutate(random, copy[index]);
    }
    return copy;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {
      ...(value as Record<string, unknown>),
    };
    const keys = Object.keys(copy);
    const action = random.int(keys.length === 0 ? 2 : 6);
    if (action === 0) copy[randomKey(random)] = randomValue(random);
    else if (action === 1)
      return random.chance(0.2) ? randomValue(random) : copy;
    else if (action === 2) {
      const dropped = random.pick(keys);
      return Object.fromEntries(
        Object.entries(copy).filter(([key]) => key !== dropped),
      );
    } else {
      const key = random.pick(keys);
      copy[key] = mutate(random, copy[key]);
    }
    return copy;
  }
  if (typeof value === "number") {
    const action = random.int(4);
    if (action === 0) return random.pick(NUMBERS);
    if (action === 1) return -value;
    if (action === 2) return String(value);
    return value + random.pick([0.5, 1, -1, 1e-9]);
  }
  if (typeof value === "string") {
    const action = random.int(5);
    if (action === 0) return randomText(random);
    if (action === 1) return ` ${value} `;
    if (action === 2) return value.toUpperCase();
    if (action === 3) return value + randomText(random, 2);
    return randomValue(random, 0);
  }
  return randomValue(random, 1);
}

/** `mutate` applied one to three times. */
export function mutateSome(random: Random, value: unknown): unknown {
  let result = value;
  const times = 1 + random.int(3);
  for (let i = 0; i < times; i++) result = mutate(random, result);
  return result;
}

const QUERY_VALUES = [
  "",
  "true",
  "false",
  "TRUE",
  "1",
  "0",
  "yes",
  "all",
  "-1",
  "2",
  "5000",
  "1e2",
  " 3",
  "abc",
  "%20",
  "%C3%A9",
  "0x10",
  "2.7",
  "-0",
  "null",
  "+1",
  "%2B1",
  "tr+ue",
  "%E0%A4",
  "%zz",
  "%74rue",
];

/** A query string of up to three `name=value` pairs drawn from `names`, repeats allowed. */
export function randomQuery(random: Random, names: readonly string[]): string {
  const count = random.int(4);
  const pairs: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = random.chance(0.9) ? random.pick(names) : "other";
    pairs.push(
      random.chance(0.1) ? name : `${name}=${random.pick(QUERY_VALUES)}`,
    );
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** `copies` mutants of each step with a body; steps without one are left out. */
export function mutatedSteps(
  random: Random,
  steps: readonly MutationStep[],
  copies: number,
): MutationStep[] {
  const out: MutationStep[] = [];
  for (const step of steps) {
    if (!("body" in step)) continue;
    for (let i = 0; i < copies; i++) {
      // The generated client only sends a JSON object or array, never a scalar.
      let body = mutateSome(random, step.body);
      while (typeof body !== "object" || body === null)
        body = mutateSome(random, step.body);
      out.push({ ...step, body });
    }
  }
  return out;
}

const CURRENCIES = [
  "USD",
  "GBP",
  "JPY",
  "CHF",
  "SEK",
  "NOK",
  "AUD",
  "CAD",
  "PLN",
  "XAU",
  "EUR",
  "usd",
  "US",
  "USDX",
];
const RATES = [
  "1.0812",
  "0.83465",
  "162.2.5",
  "0.0001",
  "0.00011",
  "100000",
  "99999.99",
  ".5",
  "5.",
  ".",
  "1e3",
  "0",
  "-1",
  " 1",
  "1 ",
  "00012.50",
  "123456789012345678901234567890",
  "0.000000000000000000001",
  "",
  "1..2",
  "١٢",
];

/** An ECB daily file of random `<Cube>` rows with varied quoting and whitespace. */
export function randomEcbXml(random: Random): string {
  const rows: string[] = [];
  const count = random.int(7);
  for (let i = 0; i < count; i++) {
    const quote = (): string => random.pick(["'", '"', "'", '"', "`", ""]);
    const space = (): string =>
      random.pick([" ", " ", "\t", "\n", "  ", "", " ", "\u000B", "﻿"]);
    const close = random.pick(["/>", " />", "/>", "></Cube>", ">"]);
    const currency = random.pick(CURRENCIES);
    const rate = random.pick(RATES);
    const q1 = quote();
    const q2 = quote();
    const tag = random.chance(0.9) ? "Cube" : "cube";
    rows.push(
      `<${tag}${space()}currency=${q1}${currency}${q1}${space()}rate=${q2}${rate}${q2}${space()}${close}`,
    );
  }
  return `<?xml version="1.0"?><gesmes:Envelope><Cube><Cube time='2025-03-03'>${rows.join("\n")}</Cube></Cube></gesmes:Envelope>`;
}

/** An open.er-api body: usually the documented shape, with random results and quotes. */
export function randomErApi(random: Random): string {
  if (random.chance(0.08))
    return random.pick([
      "",
      "{",
      "null",
      "[]",
      '"success"',
      '{"result":"success"}',
    ]);
  const rates: Record<string, unknown> = {};
  const count = random.int(6);
  for (let i = 0; i < count; i++) {
    const quote: unknown = random.chance(0.75)
      ? random.pick([
          1.09, 0.85, 3.97, 0.0001, 0.00011, 100000, 99999, 1e6, 0, -2, 1e-300,
          1.5e308, 162.25,
        ])
      : randomValue(random, 0);
    rates[random.pick(CURRENCIES)] = quote;
  }
  const body: Record<string, unknown> = {
    result: random.chance(0.85)
      ? "success"
      : random.pick(["error", "Success", "", null]),
    rates: random.chance(0.9) ? rates : random.pick([null, [], "x", 1]),
  };
  if (random.chance(0.1)) delete body.rates;
  return JSON.stringify(body);
}
