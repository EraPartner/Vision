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
 * - the corner radii, motion durations and font families of tokens.css;
 * - the design-system tokens (Phase 2a): easing curves, springs, elevation,
 *   glass blur and saturation, atmosphere alphas, the focus ring, the modal
 *   overlay and dialog geometry, hover and press states, the type ramp and
 *   the control heights, from tokens.css, index.css, tailwind.config.ts and
 *   the button, input and dialog components. Generation fails on a
 *   design-system custom property without a Swift counterpart and on any
 *   unresolved `var(--x)`.
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
  design: DesignSources;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of the first rule whose selector is exactly `selector`, comments removed. */
function ruleBody(css: string, selector: string): string {
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
  return source.slice(start, end - 1);
}

/** The custom properties declared in the first rule whose selector is exactly `selector`. */
export function ruleDeclarations(css: string, selector: string): Declarations {
  const body = ruleBody(css, selector);
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
  sources: Pick<TokenSources, "tokensCss" | "skinCss" | "themes">,
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
  const designOutput = designSection(
    sources.design,
    remToPoints(rootValue("radius"), "radius"),
  );
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

  lines.push(SUPPORT_TYPES.trimEnd(), "");
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
  lines.push(...designOutput.radius);
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
  lines.push("", ...designOutput.namespaces);

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
  const swift = lines.join("\n");
  const missing = uncoveredDesignTokens(sources.design.tokensCss.text, swift);
  if (missing.length > 0)
    throw new Error(
      `tokens.css has design-system custom properties without a Swift counterpart: ${missing.map((name) => `--${name}`).join(", ")}.`,
    );
  const unresolved = swift
    .split("\n")
    .filter(
      (line) => !line.trimStart().startsWith("//") && line.includes("var(--"),
    );
  if (unresolved.length > 0)
    throw new Error(
      `Unresolved var(--x) in the generated Swift: ${unresolved.join(" | ")}`,
    );
  return swift;
}

// ---------------------------------------------------------------------------
// Design-system tokens (Phase 2a): motion, elevation, glass, atmosphere, focus
// ring, overlay, hover, press, type ramp and control heights.
// ---------------------------------------------------------------------------

/** A source file with the repository-relative path used in doc-comment citations. */
export interface SourceFile {
  path: string;
  text: string;
}

export interface DesignSources {
  tokensCss: SourceFile;
  indexCss: SourceFile;
  tailwindConfig: SourceFile;
  buttonTsx: SourceFile;
  inputTsx: SourceFile;
  dialogTsx: SourceFile;
  motionTs: SourceFile;
}

/** The shadow and gradient colours of the glass recipes: the only `var(--x)` the parsers accept. */
const COLOR_ROLES: Record<string, string> = {
  "glass-highlight": "highlight",
  "glass-shadow": "shadow",
  "glass-surface": "surface",
  "glass-surface-soft": "surfaceSoft",
  "glass-surface-deep": "surfaceDeep",
  "glass-tint": "tint",
  "glass-border": "border",
  "sidebar-background": "sidebarBackground",
  "sidebar-border": "sidebarBorder",
  background: "background",
  foreground: "foreground",
  primary: "primary",
};

/** Custom properties of tokens.css that the Swift tokens must carry (see `uncoveredDesignTokens`). */
const COVERED_TOKEN =
  /^(ease-|spring-|elevation-|glass-(thin|regular|thick|chrome|elevated)-blur$|glass-saturate$|aurora-|grain-alpha$)/;

/**
 * Covered custom properties that are deliberately not in Swift, each with the reason.
 * Empty today: add an entry (name -> reason) instead of weakening the pattern.
 */
const UNMAPPED_TOKENS: Readonly<Record<string, string>> = {};

/** Every `--ease-*`, `--spring-*`, `--elevation-*`, glass blur/saturate, aurora and grain token. */
function designTokenNames(tokensCss: string): string[] {
  const names = new Set([
    ...Object.keys(ruleDeclarations(tokensCss, ":root")),
    ...Object.keys(ruleDeclarations(tokensCss, ".dark")),
  ]);
  return [...names].filter((name) => COVERED_TOKEN.test(name));
}

/**
 * The design-system custom properties of tokens.css that the generated Swift does not mention
 * (as a `--name` doc comment) and that are not in the allow-list. A new CSS token without a
 * Swift counterpart shows up here, and generation fails on it.
 */
export function uncoveredDesignTokens(
  tokensCss: string,
  swift: string,
  allowed: Readonly<Record<string, string>> = UNMAPPED_TOKENS,
): string[] {
  return designTokenNames(tokensCss).filter(
    (name) => !(name in allowed) && !swift.includes(`\`--${name}\``),
  );
}

function locate(
  file: SourceFile,
  pattern: RegExp,
  label: string,
): { match: RegExpExecArray; cite: string } {
  const match = pattern.exec(file.text);
  if (!match) throw new Error(`${label}: not found in ${file.path}.`);
  const first = match.index + match[0].length - match[0].trimStart().length;
  const line = file.text.slice(0, first).split("\n").length;
  return { match, cite: `${file.path}:${line}` };
}

/** The file from the first `marker` on, with the line numbers of the whole file. */
function from(file: SourceFile, marker: string): SourceFile {
  const at = file.text.indexOf(marker);
  if (at < 0) throw new Error(`No "${marker}" in ${file.path}.`);
  return {
    path: file.path,
    text: file.text.slice(0, at).replace(/[^\n]/g, "") + file.text.slice(at),
  };
}

function group(match: RegExpExecArray, index: number, label: string): string {
  const value = match[index];
  if (value === undefined)
    throw new Error(`${label}: missing capture ${index}.`);
  return value;
}

function finite(value: string, label: string): number {
  const result = Number(value);
  if (value.trim() === "" || !Number.isFinite(result))
    throw new Error(`${label}: "${value}" is not a number.`);
  return result;
}

function lengthPx(value: string, label: string): number {
  const match = /^(-?[0-9.]+)(px)?$/.exec(value);
  if (!match) throw new Error(`${label}: "${value}" is not a px length.`);
  return finite(group(match, 1, label), label);
}

function percent(value: string, label: string): number {
  const match = /^([0-9.]+)%$/.exec(value);
  if (!match) throw new Error(`${label}: "${value}" is not a percentage.`);
  return finite(group(match, 1, label), label) / 100;
}

/** Tailwind's spacing step: `p-6` is 6 * 4 = 24 points. */
function spacingPoints(step: string, label: string): number {
  return finite(step, label) * 4;
}

interface Shadow {
  role: string;
  alpha: number;
  x: number;
  y: number;
  blur: number;
  spread: number;
  inset: boolean;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * A `box-shadow` or `text-shadow` value whose colours are `hsl(var(--glass-x) / alpha)`.
 * Any other `var(--x)` is an unresolved reference and fails the generation.
 */
function parseShadows(value: string, label: string): Shadow[] {
  return splitTopLevel(value.replace(/\s+/g, " ")).map((layer) => {
    const color = /hsl\(var\(--([a-z0-9-]+)\) \/ ([0-9.]+)\)/.exec(layer);
    if (!color)
      throw new Error(
        `${label}: "${layer}" has no hsl(var(--x) / alpha) colour.`,
      );
    const variable = group(color, 1, label);
    const role = COLOR_ROLES[variable];
    if (!role)
      throw new Error(`${label}: unresolved var(--${variable}) in "${layer}".`);
    const rest = layer.replace(color[0], " ");
    if (rest.includes("var("))
      throw new Error(`${label}: unresolved var(--x) in "${layer}".`);
    const inset = /\binset\b/.test(rest);
    const lengths = rest
      .replace(/\binset\b/, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((length) => lengthPx(length, label));
    if (lengths.length < 2 || lengths.length > 4)
      throw new Error(`${label}: "${layer}" does not have 2 to 4 lengths.`);
    return {
      role,
      alpha: finite(group(color, 2, label), label),
      x: lengths[0] ?? 0,
      y: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      inset,
    };
  });
}

function shadowLiteral(shadow: Shadow): string {
  return `ShadowLayer(color: .${shadow.role}, alpha: ${number(shadow.alpha)}, x: ${number(shadow.x)}, y: ${number(shadow.y)}, blur: ${number(shadow.blur)}, spread: ${number(shadow.spread)}, inset: ${shadow.inset})`;
}

/** `let name: AppearanceValue<[ShadowLayer]>` over a light and a dark list, 4-space indented members. */
function shadowMember(
  name: string,
  light: Shadow[],
  dark: Shadow[],
  indent: string,
): string[] {
  const list = (shadows: Shadow[]) =>
    shadows.map((shadow) => `${indent}        ${shadowLiteral(shadow)},`);
  return [
    `${indent}public static let ${name}: AppearanceValue<[ShadowLayer]> = AppearanceValue(`,
    `${indent}    light: [`,
    ...list(light),
    `${indent}    ],`,
    `${indent}    dark: [`,
    ...list(dark),
    `${indent}    ])`,
  ];
}

function textShadowMember(name: string, shadow: Shadow): string {
  return `        public static let ${name} = ${shadowLiteral(shadow)}`;
}

function appearance(light: number, dark: number): string {
  return `AppearanceValue(light: ${number(light)}, dark: ${number(dark)})`;
}

/** The Swift types that the design-system namespaces are made of. Inserted before `DesignTokens`. */
const SUPPORT_TYPES = `/// A value that differs between the light and dark appearance (\`:root\` and \`.dark\` in tokens.css).
public struct AppearanceValue<Value: Equatable & Sendable>: Equatable, Sendable {
    public let light: Value
    public let dark: Value

    public init(light: Value, dark: Value) {
        self.light = light
        self.dark = dark
    }

    public func value(isDark: Bool) -> Value { isDark ? dark : light }
}

/// A CSS \`cubic-bezier(x1, y1, x2, y2)\` easing curve.
public struct BezierCurve: Equatable, Sendable {
    public let x1: Double
    public let y1: Double
    public let x2: Double
    public let y2: Double

    public init(x1: Double, y1: Double, x2: Double, y2: Double) {
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
    }
}

/// A damped spring: the physical parameters of \`lib/motion.ts\` (\`springs\`), the CSS \`linear()\`
/// samples that tokens.css derives from them and the settle time that goes with the samples.
public struct SpringToken: Equatable, Sendable {
    public let mass: Double
    public let stiffness: Double
    public let damping: Double
    /// Seconds until the spring has settled (\`--spring-<name>-duration\`).
    public let settleDuration: Double
    /// The 41 samples of the spring's step response over \`settleDuration\`, from 0 to 1.
    public let samples: [Double]

    public init(mass: Double, stiffness: Double, damping: Double, settleDuration: Double, samples: [Double]) {
        self.mass = mass
        self.stiffness = stiffness
        self.damping = damping
        self.settleDuration = settleDuration
        self.samples = samples
    }
}

/// The theme colour a shadow or gradient stop is drawn in. The hue comes from the active
/// \`ThemePalette\` (see \`ThemePalette.color(_:)\`), so theme variants keep their own shadow hue.
public enum ThemeColorRole: String, CaseIterable, Sendable {
${Object.values(COLOR_ROLES)
  .map((role) => `    case ${role}`)
  .join("\n")}
}

/// One layer of a CSS \`box-shadow\` or \`text-shadow\`: \`[inset] x y blur spread hsl(role / alpha)\`,
/// in points (CSS blur is about twice SwiftUI's shadow radius).
public struct ShadowLayer: Equatable, Sendable {
    public let color: ThemeColorRole
    public let alpha: Double
    public let x: Double
    public let y: Double
    public let blur: Double
    public let spread: Double
    public let inset: Bool

    public init(color: ThemeColorRole, alpha: Double, x: Double, y: Double, blur: Double, spread: Double, inset: Bool) {
        self.color = color
        self.alpha = alpha
        self.x = x
        self.y = y
        self.blur = blur
        self.spread = spread
        self.inset = inset
    }
}

/// The face of a type role: \`--font-display\` (Fraunces) or \`--font-body\` (Inter).
public enum TypeFace: String, Sendable {
    case display
    case body
}

/// A \`type-*\` role of the web's type ramp: size and line height in points, tracking in em.
public struct TypeStyle: Equatable, Sendable {
    public let face: TypeFace
    public let size: Double
    public let lineHeight: Double
    public let weight: Int
    /// \`letter-spacing\` in em; multiply by \`size\` for points.
    public let tracking: Double

    public init(face: TypeFace, size: Double, lineHeight: Double, weight: Int, tracking: Double) {
        self.face = face
        self.size = size
        self.lineHeight = lineHeight
        self.weight = weight
        self.tracking = tracking
    }
}

`;

interface TypeRole {
  name: string;
  css: string;
}

const TYPE_ROLES: TypeRole[] = [
  { name: "largeTitle", css: "large-title" },
  { name: "title1", css: "title-1" },
  { name: "title2", css: "title-2" },
  { name: "title3", css: "title-3" },
  { name: "headline", css: "headline" },
  { name: "body", css: "body" },
  { name: "callout", css: "callout" },
  { name: "footnote", css: "footnote" },
  { name: "caption", css: "caption" },
];

const BUTTON_SIZES: { name: string; key: string }[] = [
  { name: "height", key: "default" },
  { name: "heightSm", key: "sm" },
  { name: "heightXs", key: "xs" },
  { name: "heightLg", key: "lg" },
];

const MAX_WIDTH_REM: Record<string, number> = {
  xs: 20,
  sm: 24,
  md: 28,
  lg: 32,
  xl: 36,
  "2xl": 42,
};

interface DesignOutput {
  /** Members appended to `Radius`. */
  radius: string[];
  /** Namespaces appended after `FontFamily`, each starting with a blank line. */
  namespaces: string[];
}

/** Parses the web sources and renders the Swift for every design-system namespace. */
function designSection(
  design: DesignSources,
  radiusBase: number,
): DesignOutput {
  const tokens = design.tokensCss;
  const index = design.indexCss;
  const tailwind = design.tailwindConfig;
  const root = ruleDeclarations(tokens.text, ":root");
  const dark = ruleDeclarations(tokens.text, ".dark");
  const rootValue = (name: string) =>
    resolve(name, (key) => root[key], ":root");
  const darkValue = (name: string) => {
    const value = dark[name];
    if (value === undefined)
      throw new Error(`.dark: --${name} is not defined.`);
    return resolve(name, () => value, ".dark");
  };
  const lines: string[] = [];
  const space = () => lines.push("");

  // --- Radius (extended): Tailwind's borderRadius scale around --radius.
  const radius: string[] = [];
  for (const [key, name] of [
    ["lg", "lg"],
    ["md", "md"],
    ["sm", "sm"],
    ["xl", "xl"],
    ['"2xl"', "x2l"],
  ] as const) {
    const found = locate(
      from(tailwind, "borderRadius:"),
      new RegExp(
        `${key}:\\s*"(var\\(--radius\\)|calc\\(var\\(--radius\\) ([+-]) (\\d+)px\\))"`,
      ),
      `borderRadius.${key}`,
    );
    const offset =
      found.match[2] === undefined
        ? 0
        : (found.match[2] === "-" ? -1 : 1) *
          finite(group(found.match, 3, key), key);
    const sign = offset < 0 ? "-" : "+";
    radius.push(
      `        /// \`rounded-${key.replaceAll('"', "")}\`: \`--radius\`${offset === 0 ? "" : ` ${sign} ${Math.abs(offset)}px`} (${found.cite}).`,
      `        public static let ${name}: Double = ${number(radiusBase + offset)}`,
    );
  }

  // --- Ease
  lines.push(
    "    /// Easing curves (cubic-bezier control points).",
    "    public enum Ease {",
  );
  for (const key of Object.keys(root).filter((name) =>
    name.startsWith("ease-"),
  )) {
    const value = rootValue(key);
    const match =
      /^cubic-bezier\(\s*(-?[0-9.]+),\s*(-?[0-9.]+),\s*(-?[0-9.]+),\s*(-?[0-9.]+)\s*\)$/.exec(
        value,
      );
    if (!match) throw new Error(`--${key}: "${value}" is not a cubic-bezier.`);
    const [x1, y1, x2, y2] = [1, 2, 3, 4].map((i) =>
      number(finite(group(match, i, key), key)),
    );
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${camelCase(key.replace(/^ease-/, ""))} = BezierCurve(x1: ${x1}, y1: ${y1}, x2: ${x2}, y2: ${y2})`,
    );
  }
  lines.push("    }");
  space();

  // --- Spring
  const springsSource = from(design.motionTs, "export const springs");
  lines.push(
    "    /// Damped springs, with the CSS samples of tokens.css and the physics of lib/motion.ts.",
    "    public enum Spring {",
  );
  for (const key of Object.keys(root).filter((name) =>
    /^spring-[a-z]+$/.test(name),
  )) {
    const name = key.replace(/^spring-/, "");
    const sampled = /^linear\((.*)\)$/.exec(rootValue(key));
    if (!sampled) throw new Error(`--${key} is not a linear() easing.`);
    const samples = group(sampled, 1, key)
      .split(",")
      .map((sample) => number(finite(sample.trim(), key)));
    if (samples.length < 2) throw new Error(`--${key} has no samples.`);
    const settle = millisecondsToSeconds(
      rootValue(`${key}-duration`),
      `${key}-duration`,
    );
    const physics = locate(
      springsSource,
      new RegExp(`${name}:\\s*\\{([^}]*)\\}`),
      `springs.${name}`,
    );
    const body = group(physics.match, 1, name);
    const physicsCite = physics.cite;
    const parameter = (field: string) => {
      const found = new RegExp(`${field}:\\s*([0-9.]+)`).exec(body);
      if (!found) throw new Error(`springs.${name}: no ${field}.`);
      return number(finite(group(found, 1, field), field));
    };
    lines.push(
      `        /// \`--${key}\` sampled at ${samples.length} points, settling in \`--${key}-duration\`; physics from \`springs.${name}\` (${physicsCite}).`,
      `        public static let ${name} = SpringToken(`,
      `            mass: ${parameter("mass")}, stiffness: ${parameter("stiffness")}, damping: ${parameter("damping")},`,
      `            settleDuration: ${number(settle)},`,
      `            samples: [${samples.join(", ")}])`,
    );
  }
  lines.push("    }");
  space();

  // --- Elevation
  lines.push(
    "    /// Contact plus ambient shadow per level (inset highlight first); hues come from the glass tokens.",
    "    public enum Elevation {",
  );
  const levels = Object.keys(root)
    .filter((name) => /^elevation-[0-9]+$/.test(name))
    .sort();
  for (const key of levels) {
    lines.push(
      `        /// \`--${key}\``,
      ...shadowMember(
        `level${key.replace(/^elevation-/, "")}`,
        parseShadows(rootValue(key), `:root --${key}`),
        parseShadows(darkValue(key), `.dark --${key}`),
        "        ",
      ),
    );
  }
  for (const [key, name] of [
    ["glass-soft", "glassSoft"],
    ["glass-elevated", "glassElevated"],
  ] as const) {
    const found = locate(
      tailwind,
      new RegExp(`"${key}":\\s*"([^"]+)"`),
      `boxShadow.${key}`,
    );
    const shadows = parseShadows(
      group(found.match, 1, key),
      `boxShadow.${key}`,
    );
    lines.push(
      `        /// \`shadow-${key}\` (${found.cite}); the same in both appearances.`,
      ...shadowMember(name, shadows, shadows, "        "),
    );
  }
  lines.push("    }");
  space();

  // --- Glass
  lines.push(
    "    /// Backdrop blur (points) and saturation per glass material.",
    "    public enum Glass {",
  );
  for (const key of Object.keys(root).filter((name) =>
    /^glass-[a-z]+-blur$/.test(name),
  )) {
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${camelCase(key.replace(/^glass-/, ""))}: Double = ${number(lengthPx(rootValue(key), key))}`,
    );
  }
  lines.push(
    "        /// `--glass-saturate`, as a multiplier (180% is 1.8).",
    `        public static let saturate: AppearanceValue<Double> = ${appearance(percent(rootValue("glass-saturate"), "glass-saturate"), percent(darkValue("glass-saturate"), "glass-saturate"))}`,
  );
  const reduced = locate(
    index,
    /@media \(prefers-reduced-transparency: reduce\) \{\s*\.glass,[\s\S]*?background: hsl\(var\(--card\) \/ ([0-9.]+)\)/,
    "reduced-transparency fallback",
  );
  const reducedLine = locate(
    index,
    /background: hsl\(var\(--card\) \/ [0-9.]+\);\s*\}\s*\.liquid-canvas/,
    "reduced-transparency fallback",
  );
  lines.push(
    `        /// Opacity of \`--card\` that replaces every glass material under Reduce Transparency (\`prefers-reduced-transparency: reduce\`, ${reducedLine.cite}).`,
    `        public static let reducedTransparencyOpacity: Double = ${number(finite(group(reduced.match, 1, "reduced"), "reduced"))}`,
  );
  const contrast = locate(
    index,
    /@media \(prefers-contrast: more\) \{\s*\.glass,[\s\S]*?border-color: hsl\(var\(--foreground\) \/ ([0-9.]+)\)/,
    "high-contrast border",
  );
  lines.push(
    `        /// Alpha of the \`--foreground\` border of glass materials and cards under Increase Contrast (\`prefers-contrast: more\`, ${contrast.cite}).`,
    `        public static let highContrastBorderAlpha: Double = ${number(finite(group(contrast.match, 1, "contrast"), "contrast"))}`,
    "    }",
  );
  space();

  // --- Atmosphere
  lines.push(
    "    /// The liquid canvas: aurora blob and grain alphas.",
    "    public enum Atmosphere {",
  );
  for (const key of [
    "aurora-primary-alpha",
    "aurora-accent-alpha",
    "aurora-wash-alpha",
    "grain-alpha",
  ]) {
    lines.push(
      `        /// \`--${key}\``,
      `        public static let ${camelCase(key.replace(/^aurora-/, ""))}: AppearanceValue<Double> = ${appearance(finite(rootValue(key), key), finite(darkValue(key), key))}`,
    );
  }
  lines.push("    }");
  space();

  // --- FocusRing
  const focus = ruleBody(index.text, ":focus-visible");
  const focusWidth = /outline:\s*([0-9.]+)px solid/.exec(focus);
  const focusOffset = /outline-offset:\s*([0-9.]+)px/.exec(focus);
  if (!focusWidth || !focusOffset)
    throw new Error("The :focus-visible rule has no 3px outline and offset.");
  const focusCite = locate(
    index,
    /:focus-visible \{\s*outline:/,
    "focus ring",
  ).cite;
  locate(
    index,
    /@media \(prefers-contrast: more\) \{\s*:focus-visible \{\s*outline-color: hsl\(var\(--ring\)\);/,
    "focus ring under Increase Contrast",
  );
  lines.push(
    "    /// The keyboard focus ring: a translucent outline in `ring` (alpha `ThemePalette.focusRingAlpha`).",
    "    public enum FocusRing {",
    `        /// Outline width (\`outline: 3px solid\`, ${focusCite}).`,
    `        public static let width: Double = ${number(finite(group(focusWidth, 1, "width"), "width"))}`,
    `        /// \`outline-offset\` (${focusCite}).`,
    `        public static let offset: Double = ${number(finite(group(focusOffset, 1, "offset"), "offset"))}`,
    "        /// Alpha of the ring under Increase Contrast, where the outline is the opaque `--ring` (`prefers-contrast: more`).",
    "        public static let highContrastAlpha: Double = 1",
    "    }",
  );
  space();

  // --- Overlay
  const scrim = locate(
    index,
    /\.modal-overlay \{\s*background: hsl\(var\(--background\) \/ ([0-9.]+)\);/,
    ".modal-overlay",
  );
  const frosted = locate(
    index,
    /:root\.fx-full \.modal-overlay \{\s*background: hsl\(var\(--background\) \/ ([0-9.]+)\);\s*-webkit-backdrop-filter: blur\(([0-9.]+)px\);/,
    ":root.fx-full .modal-overlay",
  );
  const strong = locate(
    index,
    /:root\.fx-full \.modal-overlay-strong \{\s*background: hsl\(var\(--background\) \/ ([0-9.]+)\);/,
    ":root.fx-full .modal-overlay-strong",
  );
  const dialogWidth = locate(
    design.dialogTsx,
    /\bmax-w-(xs|sm|md|lg|xl|2xl) /,
    "dialog max width",
  );
  const widthRem = MAX_WIDTH_REM[group(dialogWidth.match, 1, "width")];
  if (widthRem === undefined) throw new Error("Unknown dialog max width.");
  const dialogHeight = locate(
    design.dialogTsx,
    /\bmax-h-\[([0-9]+)vh\]/,
    "dialog max height",
  );
  const dialogPadding = locate(
    design.dialogTsx,
    /\bp-([0-9.]+) data-\[state=open\]:animate-dialog-in/,
    "dialog padding",
  );
  const dialogGap = locate(
    design.dialogTsx,
    /\bgap-([0-9.]+) overflow-y-auto/,
    "dialog gap",
  );
  const dialogRadius = locate(
    design.dialogTsx,
    /\brounded-sheet\b/,
    "dialog radius",
  );
  const dialogIn = locate(
    tailwind,
    /"dialog-in": \{\s*from: \{ opacity: "0", transform: "scale\(([0-9.]+)\) translateY\(([0-9.]+)px\)" \}/,
    "dialog-in keyframes",
  );
  const dialogOut = locate(
    tailwind,
    /"dialog-out": \{[\s\S]*?scale\(var\(--genie-scale, ([0-9.]+)\)\) translateY\(var\(--genie-y, ([0-9.]+)px\)\)/,
    "dialog-out keyframes",
  );
  lines.push(
    "    /// Modal overlay (scrim) and dialog geometry; sheets and alert dialogs share the scrim.",
    "    public enum Overlay {",
    `        /// Flat scrim: \`--background\` at this alpha (\`.modal-overlay\`, ${scrim.cite}).`,
    `        public static let scrim: Double = ${number(finite(group(scrim.match, 1, "scrim"), "scrim"))}`,
    `        /// Frosted scrim (Full effects or the enhanced tier): \`--background\` at this alpha with \`blur\` behind (\`:root.fx-full .modal-overlay\`, ${frosted.cite}).`,
    `        public static let scrimFrosted: Double = ${number(finite(group(frosted.match, 1, "frosted"), "frosted"))}`,
    `        /// Frosted scrim of alert dialogs (\`modal-overlay-strong\`, ${strong.cite}); the flat scrim keeps \`scrim\`.`,
    `        public static let scrimFrostedStrong: Double = ${number(finite(group(strong.match, 1, "strong"), "strong"))}`,
    `        /// Backdrop blur radius of the frosted scrim, in points (${frosted.cite}).`,
    `        public static let blur: Double = ${number(finite(group(frosted.match, 2, "blur"), "blur"))}`,
    `        /// Corner radius of dialogs and sheets: \`rounded-sheet\` (\`--radius-sheet\`, ${dialogRadius.cite}).`,
    `        public static let dialogRadius: Double = ${number(remToPoints(rootValue("radius-sheet"), "radius-sheet"))}`,
    `        /// Widest a dialog grows: \`max-w-${group(dialogWidth.match, 1, "width")}\` (${dialogWidth.cite}).`,
    `        public static let dialogMaxWidth: Double = ${number(widthRem * ROOT_FONT_SIZE)}`,
    `        /// Tallest a dialog grows, as a fraction of the window: \`max-h-[${group(dialogHeight.match, 1, "height")}vh]\` (${dialogHeight.cite}).`,
    `        public static let dialogMaxHeightFraction: Double = ${number(finite(group(dialogHeight.match, 1, "height"), "height") / 100)}`,
    `        /// Dialog padding: \`p-${group(dialogPadding.match, 1, "padding")}\` (${dialogPadding.cite}).`,
    `        public static let dialogPadding: Double = ${number(spacingPoints(group(dialogPadding.match, 1, "padding"), "padding"))}`,
    `        /// Gap between dialog sections: \`gap-${group(dialogGap.match, 1, "gap")}\` (${dialogGap.cite}).`,
    `        public static let dialogGap: Double = ${number(spacingPoints(group(dialogGap.match, 1, "gap"), "gap"))}`,
    `        /// Scale a dialog enters from (\`dialog-in\` keyframes, ${dialogIn.cite}); it settles on \`Spring.smooth\`.`,
    `        public static let enterScale: Double = ${number(finite(group(dialogIn.match, 1, "scale"), "scale"))}`,
    "        /// Points a dialog enters below its resting place (`dialog-in` keyframes, same rule).",
    `        public static let enterOffsetY: Double = ${number(finite(group(dialogIn.match, 2, "y"), "y"))}`,
    `        /// Scale a dialog leaves to when it has no trigger to shrink toward (\`dialog-out\` fallback, ${dialogOut.cite}); it exits over \`Duration.dismiss\` on \`Ease.glide\`.`,
    `        public static let exitScale: Double = ${number(finite(group(dialogOut.match, 1, "scale"), "scale"))}`,
    "        /// Points a dialog leaves below its resting place (`dialog-out` fallback, same rule).",
    `        public static let exitOffsetY: Double = ${number(finite(group(dialogOut.match, 2, "y"), "y"))}`,
    "    }",
  );
  space();

  // --- Hover
  const fill = locate(
    design.buttonTsx,
    /hover:bg-primary\/([0-9]+)/,
    "button hover fill",
  );
  const ghost = locate(
    design.buttonTsx,
    /hover:bg-foreground\/\[([0-9.]+)\]/,
    "ghost hover fill",
  );
  const hoverBorder = locate(
    index,
    /\.premium-frame-interactive:hover \{\s*border-color: hsl\(var\(--primary\) \/ ([0-9.]+)\)/,
    "interactive card hover border",
  );
  const hoverBorderDark = locate(
    index,
    /\.dark \.premium-frame-interactive:hover \{\s*border-color: hsl\(var\(--primary\) \/ ([0-9.]+)\)/,
    "dark interactive card hover border",
  );
  const liftOf = (selector: string, label: string) => {
    const value = /box-shadow:\s*([^;]+);/.exec(ruleBody(index.text, selector));
    if (!value) throw new Error(`${label}: no box-shadow.`);
    return parseShadows(group(value, 1, label), label);
  };
  const lift = liftOf(".premium-frame-interactive::after", "card hover shadow");
  const liftDark = liftOf(
    ".dark .premium-frame-interactive::after",
    "dark card hover shadow",
  );
  const liftCite = locate(
    index,
    /\.premium-frame-interactive::after \{/,
    "card hover shadow",
  ).cite;
  lines.push(
    "    /// Hover states.",
    "    public enum Hover {",
    `        /// \`hover:bg-primary/${group(fill.match, 1, "fill")}\`: default, destructive and accent buttons (${fill.cite}).`,
    `        public static let fillAlpha: Double = ${number(finite(group(fill.match, 1, "fill"), "fill") / 100)}`,
    `        /// \`hover:bg-foreground/[${group(ghost.match, 1, "ghost")}]\`: ghost buttons (${ghost.cite}).`,
    `        public static let ghostFillAlpha: Double = ${number(finite(group(ghost.match, 1, "ghost"), "ghost"))}`,
    `        /// Alpha of the \`--primary\` border of an interactive card on hover (\`.premium-frame-interactive:hover\`, ${hoverBorder.cite}; dark ${hoverBorderDark.cite}).`,
    `        public static let cardBorderAlpha: AppearanceValue<Double> = ${appearance(finite(group(hoverBorder.match, 1, "border"), "border"), finite(group(hoverBorderDark.match, 1, "border"), "border"))}`,
    `        /// The lift shadow an interactive card shows on hover (\`.premium-frame-interactive::after\`, ${liftCite}).`,
    ...shadowMember("cardShadow", lift, liftDark, "        "),
    "    }",
  );
  space();

  // --- Press
  const press = locate(
    index,
    /\.press-feedback:active \{\s*transform: scale\(([0-9.]+)\)/,
    ".press-feedback:active",
  );
  lines.push(
    "    /// Press feedback; it animates over `Duration.press` with ease-out.",
    "    public enum Press {",
    `        /// \`.press-feedback:active\` scale (${press.cite}).`,
    `        public static let scale: Double = ${number(finite(group(press.match, 1, "press"), "press"))}`,
    "    }",
  );
  space();

  // --- Selection
  const selection = locate(
    index,
    /::selection \{\s*background: hsl\(var\(--primary\) \/ ([0-9.]+)\)/,
    "::selection",
  );
  lines.push(
    "    /// Text selection.",
    "    public enum Selection {",
    `        /// \`::selection\` background: \`--primary\` at this alpha (${selection.cite}).`,
    `        public static let alpha: Double = ${number(finite(group(selection.match, 1, "selection"), "selection"))}`,
    "    }",
  );
  space();

  // --- Halo
  const single = locate(
    index,
    /\.dark \.page-header-subtitle \{\s*text-shadow:\s*([^;]+);/,
    "page header halo",
  );
  const full = locate(
    index,
    /\.dark\.fx-full \.canvas-text :is\(h1, h2, h3, p, span, div\) \{\s*text-shadow:\s*([^;]+);/,
    "Full effects halo",
  );
  const [fullInner, fullOuter] = parseShadows(
    group(full.match, 1, "halo"),
    "Full effects halo",
  );
  const [singleLayer] = parseShadows(
    group(single.match, 1, "halo"),
    "page header halo",
  );
  if (!singleLayer || !fullInner || !fullOuter)
    throw new Error("The text halos do not have the expected layers.");
  lines.push(
    "    /// Dark-mode text halos (`text-shadow` in `--background`) that keep text legible over the aurora.",
    "    public enum Halo {",
    `        /// The single halo of page header titles and subtitles (\`.dark .page-header-title\`, ${single.cite}).`,
    textShadowMember("single", singleLayer),
    `        /// The inner layer of the double halo under Full effects (\`.dark.fx-full h1\`, ${full.cite}).`,
    textShadowMember("fullInner", fullInner),
    "        /// The outer layer of the double halo under Full effects (same rule).",
    textShadowMember("fullOuter", fullOuter),
    "    }",
  );
  space();

  // --- Type
  const faceOf: Record<string, string> = {
    "var(--font-display)": "display",
    "var(--font-body)": "body",
  };
  lines.push(
    "    /// The type ramp of `@utility type-*`: sizes and line heights in points, tracking in em.",
    "    public enum `Type` {",
  );
  for (const role of TYPE_ROLES) {
    const found = locate(
      index,
      new RegExp(`@utility type-${role.css} \\{([^}]*)\\}`),
      `type-${role.css}`,
    );
    const body = group(found.match, 1, role.css);
    const property = (name: string) => {
      const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
      if (!value) throw new Error(`type-${role.css}: no ${name}.`);
      return group(value, 1, name).trim();
    };
    const face = faceOf[property("font-family")];
    if (!face)
      throw new Error(
        `type-${role.css}: unknown font-family "${property("font-family")}".`,
      );
    const tracking =
      /^(-?[0-9.]+)em$/.exec(property("letter-spacing")) ??
      (property("letter-spacing") === "0" ? ["0", "0"] : null);
    if (!tracking)
      throw new Error(`type-${role.css}: letter-spacing is not in em.`);
    lines.push(
      `        /// \`type-${role.css}\` (${found.cite}).`,
      `        public static let ${role.name} = TypeStyle(face: .${face}, size: ${number(remToPoints(property("font-size"), role.css))}, lineHeight: ${number(remToPoints(property("line-height"), role.css))}, weight: ${number(finite(property("font-weight"), role.css))}, tracking: ${number(finite(tracking[1] ?? "0", role.css))})`,
    );
  }
  const twoXs = locate(
    tailwind,
    /'2xs': \['([0-9.]+)rem', \{ lineHeight: '([0-9.]+)rem' \}\]/,
    "fontSize.2xs",
  );
  lines.push(
    `        /// \`text-2xs\`, 11px over 14px in the body face at regular weight (fontSize \`2xs\`, ${twoXs.cite}).`,
    `        public static let twoXS = TypeStyle(face: .body, size: ${number(remToPoints(`${group(twoXs.match, 1, "2xs")}rem`, "2xs"))}, lineHeight: ${number(remToPoints(`${group(twoXs.match, 2, "2xs")}rem`, "2xs"))}, weight: 400, tracking: 0)`,
  );
  const bodyTracking = locate(
    index,
    /\n\s*body \{[^}]*?letter-spacing: (-?[0-9.]+)em/,
    "body letter-spacing",
  );
  const headingTracking = locate(
    index,
    /\.font-display \{[^}]*?letter-spacing: (-?[0-9.]+)em/,
    "heading letter-spacing",
  );
  lines.push(
    `        /// \`body { letter-spacing }\`: tracking of text outside a \`type-*\` role, in em (${bodyTracking.cite}).`,
    `        public static let bodyTracking: Double = ${number(finite(group(bodyTracking.match, 1, "tracking"), "tracking"))}`,
    `        /// \`h1, h2, h3, .font-display { letter-spacing }\`: tracking of headings outside a \`type-*\` role, in em (${headingTracking.cite}).`,
    `        public static let headingTracking: Double = ${number(finite(group(headingTracking.match, 1, "tracking"), "tracking"))}`,
    "    }",
    "",
    "    /// `Type` spelled without backticks. `Type` also names a metatype, so `DesignTokens.Type` is not this enum; write DesignTokens.`Type` or use this alias.",
    "    public typealias Typography = `Type`",
  );
  space();

  // --- Control heights
  const heights = BUTTON_SIZES.map(({ name, key }) => {
    const found = locate(
      design.buttonTsx,
      new RegExp(`\\b${key}: "h-([0-9.]+)[ "]`),
      `button size ${key}`,
    );
    return {
      name,
      key,
      found,
      points: spacingPoints(group(found.match, 1, key), key),
    };
  });
  const input = locate(
    design.inputTsx,
    /"flex h-([0-9.]+) w-full/,
    "input height",
  );
  const buttonDefault = heights[0];
  if (
    !buttonDefault ||
    spacingPoints(group(input.match, 1, "input"), "input") !==
      buttonDefault.points
  )
    throw new Error("Input and default button heights disagree.");
  lines.push(
    "    /// Control heights in points (Tailwind `h-*` classes; there are no CSS variables for them).",
    "    public enum Control {",
  );
  for (const { name, key, found, points } of heights) {
    const extra =
      key === "default"
        ? `; inputs and selects use the same \`h-${group(input.match, 1, "input")}\` (${input.cite})`
        : "";
    lines.push(
      `        /// Button \`size\` \`${key}\`: \`h-${group(found.match, 1, key)}\` (${found.cite})${extra}.`,
      `        public static let ${name}: Double = ${number(points)}`,
    );
  }
  lines.push("    }");

  return { radius, namespaces: lines };
}

interface ThemesModule {
  themes: Themes;
  THEME_VARIANTS: readonly string[];
}

function sourceFile(file: string): SourceFile {
  return { path: file, text: fs.readFileSync(repoPath(file), "utf8") };
}

/** The web sources of the design-system tokens, read from the repository. */
export function loadDesignSources(): DesignSources {
  return {
    tokensCss: sourceFile("apps/frontend/src/styles/tokens.css"),
    indexCss: sourceFile("apps/frontend/src/index.css"),
    tailwindConfig: sourceFile("apps/frontend/tailwind.config.ts"),
    buttonTsx: sourceFile("apps/frontend/src/components/ui/button.tsx"),
    inputTsx: sourceFile("apps/frontend/src/components/ui/input.tsx"),
    dialogTsx: sourceFile("apps/frontend/src/components/ui/dialog.tsx"),
    motionTs: sourceFile("apps/frontend/src/lib/motion.ts"),
  };
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
    design: loadDesignSources(),
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
