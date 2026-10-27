/**
 * Experiment variants for the Mac performance baseline: parsing of
 * `--variant <name>=<file>`, the CDP expressions that inject a variant into the
 * running renderer, and the blur-surface census.
 */
import fs from "node:fs";
import path from "node:path";

/** Name of the implicit variant that injects nothing. */
export const BASE_VARIANT = "base";
export const VARIANT_NAME = /^[a-z0-9-]+$/;
/** Id of the <style> element a CSS variant is appended in. */
export const VARIANT_STYLE_ID = "mac-baseline-variant";

export interface VariantSpec {
  name: string;
  file: string;
}

export interface Variant {
  name: string;
  /** Absolute path of the variant file; null for base. */
  file: string | null;
  kind: "none" | "css" | "js";
  content: string;
}

/** Parse one `--variant <name>=<file>` value. */
export function parseVariantSpec(spec: string): VariantSpec {
  const separator = spec.indexOf("=");
  if (separator < 1 || separator === spec.length - 1) {
    throw new Error(`--variant takes <name>=<file>, not "${spec}"`);
  }
  const name = spec.slice(0, separator).trim();
  const file = spec.slice(separator + 1).trim();
  if (!VARIANT_NAME.test(name)) {
    throw new Error(`Variant name "${name}" must match [a-z0-9-]+`);
  }
  if (name === BASE_VARIANT) {
    throw new Error(
      `"${BASE_VARIANT}" is the implicit no-injection variant; pick another name`,
    );
  }
  if (!file) throw new Error(`--variant ${name} needs a file`);
  return { name, file };
}

export function parseVariantSpecs(specs: readonly string[]): VariantSpec[] {
  const parsed = specs.map(parseVariantSpec);
  const seen = new Set<string>();
  for (const { name } of parsed) {
    if (seen.has(name)) throw new Error(`Variant "${name}" given twice`);
    seen.add(name);
  }
  return parsed;
}

/**
 * Read every variant file (failing at startup when one is missing) and return
 * the variants with the implicit base first. A relative file is looked up from
 * the working directory, then in `variantsDir`.
 */
export function loadVariants(
  specs: readonly string[],
  variantsDir: string,
): Variant[] {
  const variants: Variant[] = [
    { name: BASE_VARIANT, file: null, kind: "none", content: "" },
  ];
  for (const spec of parseVariantSpecs(specs)) {
    const candidates = [
      path.resolve(spec.file),
      path.resolve(variantsDir, spec.file),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) {
      throw new Error(
        `Variant file for "${spec.name}" not found: ${spec.file} (also looked in ${variantsDir})`,
      );
    }
    const extension = path.extname(file).toLowerCase();
    if (extension !== ".css" && extension !== ".js") {
      throw new Error(
        `Variant file for "${spec.name}" must end in .css or .js: ${file}`,
      );
    }
    variants.push({
      name: spec.name,
      file,
      kind: extension === ".css" ? "css" : "js",
      content: fs.readFileSync(file, "utf8"),
    });
  }
  return variants;
}

export interface VariantInjection {
  applied: boolean;
  /** "style" (<style> element), "adopted" (constructable sheet), "js" or "none". */
  method: string;
}

/**
 * Expression that tags <html> with the variant and, for a CSS file, appends
 * <style id="mac-baseline-variant">. When the app's CSP leaves the <style>
 * without a sheet it falls back to a constructed stylesheet, which CSP does
 * not govern, and reports the method used.
 */
export function cssInjectionExpression(variant: Variant): string {
  return `(() => {
    document.documentElement.dataset.fxVariant = ${JSON.stringify(variant.name)};
    document.getElementById(${JSON.stringify(VARIANT_STYLE_ID)})?.remove();
    const css = ${JSON.stringify(variant.content)};
    const style = document.createElement("style");
    style.id = ${JSON.stringify(VARIANT_STYLE_ID)};
    style.textContent = css;
    document.head.appendChild(style);
    if (style.sheet) return { applied: true, method: "style" };
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return { applied: true, method: "adopted" };
    } catch {
      return { applied: false, method: "none" };
    }
  })()`;
}

/** Expression for a .js variant: tag <html>, then run the file's content. */
export function jsInjectionExpression(variant: Variant): string {
  return `(() => {
    document.documentElement.dataset.fxVariant = ${JSON.stringify(variant.name)};
    return { applied: true, method: "js" };
  })()`;
}

/**
 * On-screen area of elements whose computed backdrop-filter is not "none", as
 * a percentage of the viewport, plus their count. Each element is clipped to
 * the viewport; overlapping or nested surfaces are summed, so the value can
 * exceed 100 and measures blur work, not covered pixels. A filtered ::before
 * (the material layer of a material-host card, index.css) counts with its
 * host's box, which it covers.
 */
export const GLASS_CENSUS = `(() => {
  const viewport = innerWidth * innerHeight;
  let area = 0;
  let surfaces = 0;
  const filtered = (style) => {
    const filter = style.backdropFilter || style.webkitBackdropFilter || "none";
    return filter !== "none";
  };
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const before = getComputedStyle(el, "::before");
    const count =
      (filtered(style) ? 1 : 0) +
      (before.content !== "none" && filtered(before) ? 1 : 0);
    if (count === 0) continue;
    const rect = el.getBoundingClientRect();
    const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    if (width <= 0 || height <= 0) continue;
    area += count * width * height;
    surfaces += count;
  }
  return {
    areaPercent: viewport > 0 ? Math.round((area / viewport) * 1000) / 10 : 0,
    surfaces,
  };
})()`;

export interface GlassCensus {
  areaPercent: number;
  surfaces: number;
}
