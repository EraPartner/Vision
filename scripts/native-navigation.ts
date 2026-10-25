#!/usr/bin/env bun
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  generatedHeader,
  parseListFile,
  repoPath,
  swiftIdentifier,
  swiftString,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates Vision Native's sidebar registry (ADR-204 phase 2) from the web
 * app's single navigation source, apps/frontend/src/lib/navigation.ts: the
 * sections, their items, the admin section and the footer items, with each
 * Lucide page icon mapped to an SF Symbol through SF_SYMBOLS below.
 *
 *   bun run native:generate-navigation
 *
 * Every label key must be listed in apps/native/i18n-keys.txt, so the String
 * Catalog carries it.
 *
 * It also emits `NativeRoute.Destination`, one case per registry url named after
 * the item's title key (`nav.marketLookup` -> `.marketLookup`), so native code
 * builds a route from a case instead of a path literal. `NativeRoute(path:)`
 * stays the parse and serialize edge for paths that are not registry pages.
 */

export const OUTPUT =
  "apps/native/Sources/VisionNativeCore/Navigation/Generated/NavigationRegistry.swift";
const COMMAND = "native:generate-navigation";
const SOURCE =
  "scripts/native-navigation.ts from apps/frontend/src/lib/navigation.ts";
export const I18N_KEYS = "apps/native/i18n-keys.txt";

/**
 * Lucide icon (its canonical name) → SF Symbol. A new page icon fails the
 * generator until it gets a row here.
 */
export const SF_SYMBOLS: Readonly<Record<string, string>> = {
  Activity: "waveform.path.ecg",
  ArrowLeftRight: "arrow.left.arrow.right",
  BellRing: "bell.badge",
  BookOpen: "book",
  Briefcase: "briefcase",
  Building2: "building.2",
  BuildingComplex: "building",
  CalendarClock: "calendar.badge.clock",
  ChartCandlestick: "chart.bar.xaxis",
  ChartColumn: "chart.bar",
  ChartLine: "chart.xyaxis.line",
  ChartPie: "chart.pie",
  ChartSpline: "chart.line.flattrend.xyaxis",
  Coins: "bitcoinsign.circle",
  Database: "cylinder.split.1x2",
  Gem: "diamond",
  GitCompareArrows: "arrow.triangle.swap",
  Globe: "globe",
  HandCoins: "dollarsign.circle",
  Import: "square.and.arrow.down",
  Landmark: "building.columns",
  LayoutDashboard: "square.grid.2x2",
  PiggyBank: "banknote",
  Receipt: "list.bullet.rectangle.portrait",
  Scale: "scalemass",
  ServerCog: "server.rack",
  ShieldCheck: "checkmark.shield",
  Sparkles: "sparkles",
  Tags: "tag",
  Target: "scope",
  Telescope: "binoculars",
  TrendingUp: "chart.line.uptrend.xyaxis",
  Users: "person.2",
  Wallet: "wallet.pass",
  WalletCards: "creditcard",
};

/** Settings is a footer button, not a route (`?settings=`), so it is not in the registry. */
export const SETTINGS_ITEM = {
  titleKey: "layout.settings",
  symbol: "gearshape",
};

interface Icon {
  displayName?: string;
}

export interface NavItem {
  titleKey: string;
  url: string;
  icon: Icon;
  shortcutKey?: string;
  badge?: string;
  exact?: boolean;
}

export interface NavSection {
  id: string;
  labelKey?: string;
  collapsible: boolean;
  defaultHidden?: boolean;
  items: NavItem[];
}

export interface NavigationSource {
  NAV_SECTIONS: readonly NavSection[];
  ADMIN_SECTION: NavSection;
  FOOTER_NAV_ITEMS: readonly NavItem[];
}

function symbolFor(item: NavItem): string {
  const name = item.icon.displayName;
  if (!name)
    throw new Error(`${item.url}: its icon has no Lucide displayName.`);
  const symbol = SF_SYMBOLS[name];
  if (!symbol)
    throw new Error(
      `${item.url}: add an SF Symbol for the Lucide icon ${name} to SF_SYMBOLS.`,
    );
  return symbol;
}

function optionalString(value: string | undefined): string {
  return value === undefined ? "nil" : swiftString(value);
}

function itemLiteral(item: NavItem, indent: string): string {
  const fields = [
    `titleKey: ${swiftString(item.titleKey)}`,
    `url: ${swiftString(item.url)}`,
    `symbol: ${swiftString(symbolFor(item))}`,
    `shortcutKey: ${optionalString(item.shortcutKey)}`,
    `badge: ${item.badge === undefined ? "nil" : `.${badgeCase(item.badge)}`}`,
    `exact: ${item.exact === true}`,
  ];
  return `${indent}NavItem(${fields.join(", ")})`;
}

function badgeCase(badge: string): string {
  const cases: Record<string, string> = {
    "needs-category": "needsCategory",
    "planned-due": "plannedDue",
    insights: "insights",
    monitors: "monitors",
  };
  const name = cases[badge];
  if (!name) throw new Error(`Unknown nav badge ${badge}.`);
  return name;
}

function sectionLiteral(section: NavSection, indent: string): string {
  const items = section.items
    .map((item) => itemLiteral(item, `${indent}        `))
    .join(",\n");
  return [
    `${indent}NavSection(`,
    `${indent}    id: .${section.id}, labelKey: ${optionalString(section.labelKey)}, collapsible: ${section.collapsible},`,
    `${indent}    defaultHidden: ${section.defaultHidden === true},`,
    `${indent}    items: [`,
    items,
    `${indent}    ])`,
  ].join("\n");
}

/** `nav.marketLookup` -> `marketLookup`: the `NativeRoute.Destination` case of an item. */
function destinationCase(item: NavItem): string {
  const match = /^nav\.([a-z][A-Za-z0-9]*)$/.exec(item.titleKey);
  if (!match) {
    throw new Error(
      `${item.url}: the title key ${item.titleKey} cannot name a route destination (expected nav.camelCase).`,
    );
  }
  const name = match[1]!;
  return swiftIdentifier(name);
}

function destinationEnum(items: readonly NavItem[]): string[] {
  const names = new Map<string, string>();
  const urls = new Set<string>();
  const cases: string[] = [];
  for (const item of items) {
    const name = destinationCase(item);
    const owner = names.get(name);
    if (owner !== undefined) {
      throw new Error(
        `${item.url}: its title key ${item.titleKey} gives the route destination ${name}, already used by ${owner}.`,
      );
    }
    if (urls.has(item.url)) {
      throw new Error(`${item.url} is listed twice in the navigation.`);
    }
    names.set(name, item.url);
    urls.add(item.url);
    cases.push(`        case ${name} = ${swiftString(item.url)}`);
  }
  return [
    "extension NativeRoute {",
    "    /// Every page of the sidebar registry, by its path. Build a route with `NativeRoute(_:query:)`.",
    "    public enum Destination: String, CaseIterable, Sendable {",
    ...cases,
    "    }",
    "}",
  ];
}

export function generateNavigation(
  source: NavigationSource,
  listedKeys: readonly string[],
): string {
  const sections = [...source.NAV_SECTIONS];
  const allItems = [
    ...sections.flatMap((section) => section.items),
    ...source.ADMIN_SECTION.items,
    ...source.FOOTER_NAV_ITEMS,
  ];
  const keys = [
    ...sections.flatMap((section) =>
      section.labelKey ? [section.labelKey] : [],
    ),
    source.ADMIN_SECTION.labelKey ?? "",
    ...allItems.map((item) => item.titleKey),
    SETTINGS_ITEM.titleKey,
  ].filter(Boolean);
  const missing = [...new Set(keys)].filter((key) => !listedKeys.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `Add these sidebar label keys to ${I18N_KEYS}: ${missing.join(", ")}`,
    );
  }

  return [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "",
    "/// `NAV_SECTIONS`, `ADMIN_SECTION` and `FOOTER_NAV_ITEMS` of apps/frontend/src/lib/navigation.ts.",
    "public enum NavigationRegistry {",
    "    /// The always-shown sections, top to bottom. Admin is appended in admin mode.",
    "    public static let sections: [NavSection] = [",
    sections.map((section) => sectionLiteral(section, "        ")).join(",\n"),
    "    ]",
    "",
    "    /// Shown only when `appSettings.adminMode` is on.",
    "    public static let adminSection =",
    sectionLiteral(source.ADMIN_SECTION, "        "),
    "",
    "    /// The footer: the assistant. Settings follows it (`settingsItem`).",
    "    public static let footerItems: [NavItem] = [",
    source.FOOTER_NAV_ITEMS.map((item) => itemLiteral(item, "        ")).join(
      ",\n",
    ),
    "    ]",
    "",
    "    /// The Settings footer button; it opens the `?settings=` dialog of the web app.",
    `    public static let settingsTitleKey = ${swiftString(SETTINGS_ITEM.titleKey)}`,
    `    public static let settingsSymbol = ${swiftString(SETTINGS_ITEM.symbol)}`,
    "}",
    "",
    ...destinationEnum(allItems),
    "",
  ].join("\n");
}

export async function loadNavigation(): Promise<NavigationSource> {
  // A computed specifier keeps the frontend module (and its `@/` imports) out of
  // the scripts type-check; Bun resolves it with the frontend's tsconfig.
  return (await import(
    pathToFileURL(repoPath("apps/frontend/src/lib/navigation.ts")).href
  )) as NavigationSource;
}

async function main(): Promise<void> {
  try {
    const keys = parseListFile(
      fs.readFileSync(repoPath(I18N_KEYS), "utf8"),
      I18N_KEYS,
    );
    writeGenerated(
      repoPath(OUTPUT),
      generateNavigation(await loadNavigation(), keys),
    );
  } catch (error) {
    console.error(
      `[native-navigation] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) void main();
