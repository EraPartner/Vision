#!/usr/bin/env bun
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  camelCase,
  generatedHeader,
  repoPath,
  swiftIdentifier,
  swiftString,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates Vision Native's design tokens (ADR-204 phase 2) from the web app's
 * sources, so the native screens keep today's colours exactly:
 *
 * - every theme variant's light and dark palette from
 *   apps/frontend/src/styles/themes.ts (the values applyThemePalette writes);
 * - the gain/loss palette, classic (styles/tokens.css) and colorblind-safe
 *   (styles/skin-v2.css), resolved the way the cascade resolves them;
 * - the corner radii, motion durations and font families of tokens.css.
 *
 *   bun run native:generate-tokens
 */

export const OUTPUT =
  "apps/native/Sources/VisionNativeCore/Design/Generated/DesignTokens.swift";
const COMMAND = "native:generate-tokens";
const SOURCE =
  "scripts/native-design-tokens.ts from styles/tokens.css, styles/skin-v2.css and styles/themes.ts";
const ROOT_FONT_SIZE = 16;

export type Declarations = Record<string, string>;
export type ThemeTokens = Record<string, string>;
export type Themes = Record<string, { light: ThemeTokens; dark: ThemeTokens }>;

export interface TokenSources {
  tokensCss: string;
  skinCss: string;
  themes: Themes;
  variants: readonly string[];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The custom properties declared in the first rule whose selector is exactly `selector`. */
export function ruleDeclarations(css: string, selector: string): Declarations {
  const source = stripComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[{};\\s])${escaped}\\s*\\{`).exec(source);
  if (!match) throw new Error(`No "${selector}" rule.`);
  let depth = 1;
  const start = match.index + match[0].length;
  let end = start;
  for (; end < source.length && depth > 0; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
  }
  const body = source.slice(start, end - 1);
  const declarations: Declarations = {};
  for (const declaration of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations[declaration[1] ?? ""] = (declaration[2] ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return declarations;
}

interface Hsl {
  hue: number;
  saturation: number;
  lightness: number;
}

export function parseHsl(value: string, label: string): Hsl {
  const match = /^(-?[0-9.]+)\s+([0-9.]+)%\s+([0-9.]+)%$/.exec(value.trim());
  if (!match) throw new Error(`${label}: "${value}" is not HSL components.`);
  return {
    hue: Number(match[1]),
    saturation: Number(match[2]),
    lightness: Number(match[3]),
  };
}

function resolve(
  name: string,
  lookup: (name: string) => string | undefined,
  label: string,
  depth = 0,
): string {
  const value = lookup(name);
  if (value === undefined)
    throw new Error(`${label}: --${name} is not defined.`);
  const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!reference) return value;
  if (depth > 8) throw new Error(`${label}: --${name} does not resolve.`);
  return resolve(reference[1] ?? "", lookup, label, depth + 1);
}

function number(value: number): string {
  return `${value}`;
}

function hslLiteral(color: Hsl): string {
  return `HSLColor(hue: ${number(color.hue)}, saturation: ${number(color.saturation)}, lightness: ${number(color.lightness)})`;
}

function remToPoints(value: string, label: string): number {
  const match = /^([0-9.]+)rem$/.exec(value);
  if (!match) throw new Error(`${label}: "${value}" is not a rem length.`);
  return Number(match[1]) * ROOT_FONT_SIZE;
}

function millisecondsToSeconds(value: string, label: string): number {
  const match = /^([0-9.]+)ms$/.exec(value);
  if (!match)
    throw new Error(`${label}: "${value}" is not a millisecond duration.`);
  return Number(match[1]) / 1000;
}

function fontFamilies(value: string): string[] {
  return value.split(",").map((family) => family.trim().replace(/^"|"$/g, ""));
}

interface ResolvedPalette {
  colors: [string, Hsl][];
  alphas: [string, number][];
  gain: Hsl;
  loss: Hsl;
  colorblindGain: Hsl;
  colorblindLoss: Hsl;
}

/**
 * One variant in one appearance. applyThemePalette writes the palette as
 * inline custom properties, so it wins for its keys; --gain and --loss come
 * from tokens.css (@layer base: `:root`, then `.dark`, then the non-default
 * variant rule, by specificity) and, with the colorblind skin on, from
 * skin-v2.css, which is unlayered and so outranks the layered rules.
 */
export function resolvePalette(
  sources: Omit<TokenSources, "variants">,
  variant: string,
  appearance: "light" | "dark",
): ResolvedPalette {
  const label = `${variant}/${appearance}`;
  const palette = sources.themes[variant]?.[appearance];
  if (!palette) throw new Error(`${label}: no palette in themes.ts.`);
  const root = ruleDeclarations(sources.tokensCss, ":root");
  const dark =
    appearance === "dark" ? ruleDeclarations(sources.tokensCss, ".dark") : {};
  const variantRule =
    variant === "default"
      ? {}
      : ruleDeclarations(
          sources.tokensCss,
          ':root[data-theme-variant]:not([data-theme-variant="default"])',
        );
  const layered: Declarations = { ...root, ...dark, ...variantRule };
  const skin: Declarations = {
    ...ruleDeclarations(sources.skinCss, ":root.skin-v2"),
    ...(appearance === "dark"
      ? ruleDeclarations(sources.skinCss, ":root.skin-v2.dark")
      : {}),
  };
  const classic = (name: string) => palette[name] ?? layered[name];
  const colorblind = (name: string) =>
    palette[name] ?? skin[name] ?? layered[name];

  const colors: [string, Hsl][] = [];
  const alphas: [string, number][] = [];
  for (const [key, value] of Object.entries(palette)) {
    if (key.endsWith("-alpha")) {
      const alpha = Number(value);
      if (!Number.isFinite(alpha))
        throw new Error(`${label}: --${key} is not a number.`);
      alphas.push([key, alpha]);
    } else {
      colors.push([key, parseHsl(value, `${label} --${key}`)]);
    }
  }
  return {
    colors,
    alphas,
    gain: parseHsl(resolve("gain", classic, label), `${label} --gain`),
    loss: parseHsl(resolve("loss", classic, label), `${label} --loss`),
    colorblindGain: parseHsl(
      resolve("gain", colorblind, label),
      `${label} skin --gain`,
    ),
    colorblindLoss: parseHsl(
      resolve("loss", colorblind, label),
      `${label} skin --loss`,
    ),
  };
}

export function generateTokens(sources: TokenSources): string {
  const variants = [...sources.variants];
  if (variants[0] !== "default")
    throw new Error('The first theme variant must be "default".');
  const resolved = variants.flatMap((variant) =>
    (["light", "dark"] as const).map((appearance) => ({
      variant,
      appearance,
      palette: resolvePalette(sources, variant, appearance),
    })),
  );
  const first = resolved[0]?.palette;
  if (!first) throw new Error("No palettes.");
  const colorKeys = first.colors.map(([key]) => key);
  const alphaKeys = first.alphas.map(([key]) => key);
  for (const { variant, appearance, palette } of resolved) {
    const keys = [
      ...palette.colors.map(([key]) => key),
      ...palette.alphas.map(([key]) => key),
    ];
    if (keys.join() !== [...colorKeys, ...alphaKeys].join()) {
      throw new Error(
        `${variant}/${appearance} has different token keys from default/light.`,
      );
    }
  }

  const root = ruleDeclarations(sources.tokensCss, ":root");
  const rootValue = (name: string) =>
    resolve(name, (key) => root[key], ":root");
  const caseName = (variant: string) => swiftIdentifier(camelCase(variant));
  const paletteName = (variant: string, appearance: string) =>
    `${camelCase(variant)}${appearance === "light" ? "Light" : "Dark"}`;

  const lines: string[] = [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "",
  ];
  lines.push("/// `ThemeVariant` in apps/frontend/src/styles/themes.ts.");
  lines.push("public enum ThemeVariant: String, CaseIterable, Sendable {");
  for (const variant of variants)
    lines.push(`    case ${caseName(variant)} = ${swiftString(variant)}`);
  lines.push("}", "");
  lines.push("/// The resolved light or dark theme (`Theme` in the web app).");
  lines.push(
    "public enum ThemeAppearance: String, CaseIterable, Sendable {",
    "    case light",
    "    case dark",
    "}",
    "",
  );
  lines.push(
    "/// One theme variant in one appearance: the CSS custom properties of the web app.",
  );
  lines.push("public struct ThemePalette: Equatable, Sendable {");
  for (const key of colorKeys)
    lines.push(
      `    /// \`--${key}\``,
      `    public let ${swiftIdentifier(camelCase(key))}: HSLColor`,
    );
  for (const key of alphaKeys)
    lines.push(
      `    /// \`--${key}\``,
      `    public let ${swiftIdentifier(camelCase(key))}: Double`,
    );
  lines.push(
    "    /// `--gain` without the colorblind skin (gold).",
    "    public let gain: HSLColor",
  );
  lines.push(
    "    /// `--loss` without the colorblind skin (red).",
    "    public let loss: HSLColor",
  );
  lines.push(
    "    /// `--gain` with the colorblind-safe skin (`.skin-v2`).",
    "    public let colorblindGain: HSLColor",
  );
  lines.push(
    "    /// `--loss` with the colorblind-safe skin (`.skin-v2`).",
    "    public let colorblindLoss: HSLColor",
  );
  lines.push("}", "");

  lines.push("public enum DesignTokens {");
  lines.push(
    "    public static func palette(_ variant: ThemeVariant, _ appearance: ThemeAppearance) -> ThemePalette {",
  );
  lines.push("        switch (variant, appearance) {");
  for (const { variant, appearance } of resolved) {
    lines.push(
      `        case (.${camelCase(variant)}, .${appearance}): return ${paletteName(variant, appearance)}`,
    );
  }
  lines.push("        }", "    }", "");
  lines.push(
    `    /// \`--label-primary-alpha\``,
    `    public static let labelPrimaryAlpha: Double = ${number(Number(rootValue("label-primary-alpha")))}`,
    "",
  );

  lines.push(
    "    /// Corner radii in points (1rem = 16pt).",
    "    public enum Radius {",
  );
  for (const key of [
    "radius",
    "radius-chip",
    "radius-control",
    "radius-card",
    "radius-sheet",
  ]) {
    const name =
      key === "radius" ? "base" : camelCase(key.replace(/^radius-/, ""));
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${name}: Double = ${number(remToPoints(rootValue(key), key))}`,
    );
  }
  lines.push("    }", "");

  lines.push(
    "    /// Motion durations in seconds.",
    "    public enum Duration {",
  );
  for (const key of Object.keys(root).filter((name) =>
    name.startsWith("duration-"),
  )) {
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${camelCase(key.replace(/^duration-/, ""))}: Double = ${number(millisecondsToSeconds(rootValue(key), key))}`,
    );
  }
  lines.push("    }", "");

  lines.push(
    "    /// Font families, most preferred first.",
    "    public enum FontFamily {",
  );
  for (const key of ["font-display", "font-body", "font-mono"]) {
    const families = fontFamilies(rootValue(key)).map(swiftString).join(", ");
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${camelCase(key.replace(/^font-/, ""))} = [${families}]`,
    );
  }
  lines.push("    }");

  for (const { variant, appearance, palette } of resolved) {
    lines.push(
      "",
      `    static let ${paletteName(variant, appearance)} = ThemePalette(`,
    );
    const fields = [
      ...palette.colors.map(
        ([key, color]) =>
          `${swiftIdentifier(camelCase(key))}: ${hslLiteral(color)}`,
      ),
      ...palette.alphas.map(
        ([key, alpha]) =>
          `${swiftIdentifier(camelCase(key))}: ${number(alpha)}`,
      ),
      `gain: ${hslLiteral(palette.gain)}`,
      `loss: ${hslLiteral(palette.loss)}`,
      `colorblindGain: ${hslLiteral(palette.colorblindGain)}`,
      `colorblindLoss: ${hslLiteral(palette.colorblindLoss)}`,
    ];
    fields.forEach((field, index) =>
      lines.push(`        ${field}${index === fields.length - 1 ? ")" : ","}`),
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

interface ThemesModule {
  themes: Themes;
  THEME_VARIANTS: readonly string[];
}

export async function loadSources(): Promise<TokenSources> {
  // A computed specifier keeps the frontend module (and its `@/` imports) out of
  // the scripts type-check; Bun resolves it with the frontend's tsconfig.
  const themesModule = (await import(
    pathToFileURL(repoPath("apps/frontend/src/styles/themes.ts")).href
  )) as ThemesModule;
  return {
    tokensCss: fs.readFileSync(
      repoPath("apps/frontend/src/styles/tokens.css"),
      "utf8",
    ),
    skinCss: fs.readFileSync(
      repoPath("apps/frontend/src/styles/skin-v2.css"),
      "utf8",
    ),
    themes: themesModule.themes,
    variants: themesModule.THEME_VARIANTS,
  };
}

async function main(): Promise<void> {
  try {
    writeGenerated(repoPath(OUTPUT), generateTokens(await loadSources()));
  } catch (error) {
    console.error(
      `[native-design-tokens] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) void main();
