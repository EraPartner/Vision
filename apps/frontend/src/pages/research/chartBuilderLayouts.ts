import { z } from "zod";

import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import {
    DEFAULT_STATE,
    STORAGE_KEY as LEGACY_STORAGE_KEY,
    storedBuilderStateSchema,
    type BuilderState,
} from "./chartBuilderState";

export const MAX_CHART_LAYOUTS = 20;
export const MAX_CHART_INDICATORS = 20;
export const MAX_SHARED_CHART_LENGTH = 20_000;
const MAX_LIBRARY_BYTES = 250_000;

const boundedId = z.string().min(1).max(128);
const seriesSchema = z
    .object({
        id: boundedId,
        symbol: z.string().min(1).max(64),
        field: z.enum(["price", "volume"]),
        type: z.enum(["line", "area", "candlestick", "bar"]),
        axis: z.enum(["left", "right"]),
        provider: z.string().max(64),
        macro: z
            .object({
                provider: z.enum(["fred", "eurostat", "dbnomics"]),
                seriesId: z.string().min(1).max(128),
                title: z.string().min(1).max(256),
            })
            .strict()
            .optional(),
    })
    .strict();

const indicatorSchema = z
    .object({
        id: boundedId,
        type: z.enum(["sma", "ema", "bollinger"]),
        period: z.number().int().min(1).max(500),
        seriesId: boundedId,
    })
    .strict();

export const portableBuilderStateSchema = z
    .object({
        range: z.enum([
            "1d",
            "5d",
            "1mo",
            "3mo",
            "6mo",
            "1y",
            "2y",
            "5y",
            "max",
        ]),
        logLeft: z.boolean(),
        rebase: z.boolean(),
        series: z.array(seriesSchema).max(5),
        indicators: z.array(indicatorSchema).max(MAX_CHART_INDICATORS),
        oscillator: z.enum(["none", "rsi", "macd"]),
        oscillatorSeriesId: boundedId.nullable(),
    })
    .strict()
    .superRefine((state, context) => {
        const seriesIds = new Set<string>();
        for (const [index, series] of state.series.entries()) {
            if (seriesIds.has(series.id)) {
                context.addIssue({
                    code: "custom",
                    path: ["series", index, "id"],
                    message: "Series ids must be unique",
                });
            }
            seriesIds.add(series.id);
        }
        const indicatorIds = new Set<string>();
        for (const [index, indicator] of state.indicators.entries()) {
            if (indicatorIds.has(indicator.id)) {
                context.addIssue({
                    code: "custom",
                    path: ["indicators", index, "id"],
                    message: "Indicator ids must be unique",
                });
            }
            indicatorIds.add(indicator.id);
            if (!seriesIds.has(indicator.seriesId)) {
                context.addIssue({
                    code: "custom",
                    path: ["indicators", index, "seriesId"],
                    message: "Indicator series must exist",
                });
            }
        }
        if (
            state.oscillatorSeriesId !== null &&
            !seriesIds.has(state.oscillatorSeriesId)
        ) {
            context.addIssue({
                code: "custom",
                path: ["oscillatorSeriesId"],
                message: "Oscillator series must exist",
            });
        }
    });

export interface ChartBuilderLayout {
    id: string;
    name: string;
    state: BuilderState;
    createdAt: string;
    updatedAt: string;
}

export interface ChartBuilderLibrary {
    version: 2;
    activeLayoutId: string | null;
    draft: BuilderState;
    layouts: ChartBuilderLayout[];
}

const layoutSchema = z
    .object({
        id: boundedId,
        name: z.string().trim().min(1).max(80),
        state: portableBuilderStateSchema,
        createdAt: z.string().max(64),
        updatedAt: z.string().max(64),
    })
    .strict();

const librarySchema = z
    .object({
        version: z.literal(2),
        activeLayoutId: boundedId.nullable(),
        draft: portableBuilderStateSchema,
        layouts: z.array(layoutSchema).max(MAX_CHART_LAYOUTS),
    })
    .strict()
    .superRefine((library, context) => {
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const [index, layout] of library.layouts.entries()) {
            const foldedName = layout.name.toLocaleLowerCase();
            if (ids.has(layout.id) || names.has(foldedName)) {
                context.addIssue({
                    code: "custom",
                    path: ["layouts", index],
                    message: "Layout ids and names must be unique",
                });
            }
            ids.add(layout.id);
            names.add(foldedName);
        }
        if (
            library.activeLayoutId !== null &&
            !ids.has(library.activeLayoutId)
        ) {
            context.addIssue({
                code: "custom",
                path: ["activeLayoutId"],
                message: "Active layout must exist",
            });
        }
    });

const shareSchema = z
    .object({ version: z.literal(1), state: portableBuilderStateSchema })
    .strict();

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function normalizeLegacyState(state: BuilderState): BuilderState {
    const series: BuilderState["series"] = [];
    const seriesIds = new Set<string>();
    for (const candidate of state.series) {
        const parsed = seriesSchema.safeParse(candidate);
        if (!parsed.success || seriesIds.has(parsed.data.id)) continue;
        seriesIds.add(parsed.data.id);
        series.push(parsed.data as BuilderState["series"][number]);
    }

    const indicators: BuilderState["indicators"] = [];
    const indicatorIds = new Set<string>();
    for (const candidate of state.indicators) {
        if (indicators.length >= MAX_CHART_INDICATORS) break;
        const parsed = indicatorSchema.safeParse(candidate);
        if (
            !parsed.success ||
            indicatorIds.has(parsed.data.id) ||
            !seriesIds.has(parsed.data.seriesId)
        ) {
            continue;
        }
        indicatorIds.add(parsed.data.id);
        indicators.push(parsed.data as BuilderState["indicators"][number]);
    }

    return {
        range: state.range,
        logLeft: state.logLeft,
        rebase: state.rebase,
        series,
        indicators,
        oscillator: state.oscillator,
        oscillatorSeriesId:
            state.oscillatorSeriesId && seriesIds.has(state.oscillatorSeriesId)
                ? state.oscillatorSeriesId
                : null,
    };
}

export function createChartBuilderLibrary(
    draft: BuilderState = DEFAULT_STATE,
): ChartBuilderLibrary {
    return { version: 2, activeLayoutId: null, draft, layouts: [] };
}

export function getActiveBuilderState(
    library: ChartBuilderLibrary,
): BuilderState {
    if (library.activeLayoutId) {
        const layout = library.layouts.find(
            (candidate) => candidate.id === library.activeLayoutId,
        );
        if (layout) return layout.state;
    }
    return library.draft;
}

export function setActiveBuilderState(
    library: ChartBuilderLibrary,
    state: BuilderState,
    now = new Date().toISOString(),
): ChartBuilderLibrary {
    if (!portableBuilderStateSchema.safeParse(state).success) return library;
    if (!library.activeLayoutId) return { ...library, draft: state };
    return {
        ...library,
        layouts: library.layouts.map((layout) =>
            layout.id === library.activeLayoutId
                ? { ...layout, state, updatedAt: now }
                : layout,
        ),
    };
}

export function saveChartBuilderLibrary(
    library: ChartBuilderLibrary,
    storage: StorageLike = window.localStorage,
): boolean {
    if (!librarySchema.safeParse(library).success) return false;
    const serialized = JSON.stringify(library);
    if (new TextEncoder().encode(serialized).byteLength > MAX_LIBRARY_BYTES)
        return false;
    try {
        storage.setItem(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS, serialized);
        return true;
    } catch {
        return false;
    }
}

export function loadChartBuilderLibrary(
    storage: StorageLike = window.localStorage,
): ChartBuilderLibrary {
    try {
        const raw = storage.getItem(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS);
        if (raw && raw.length <= MAX_LIBRARY_BYTES) {
            const parsed = librarySchema.safeParse(JSON.parse(raw));
            if (parsed.success) return parsed.data as ChartBuilderLibrary;
        }

        const legacyRaw = storage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
            const legacy = storedBuilderStateSchema.safeParse(
                JSON.parse(legacyRaw),
            );
            if (legacy.success) {
                const migrated = createChartBuilderLibrary(
                    normalizeLegacyState(legacy.data as BuilderState),
                );
                if (saveChartBuilderLibrary(migrated, storage)) {
                    storage.removeItem(LEGACY_STORAGE_KEY);
                }
                return migrated;
            }
        }
    } catch {
        // Invalid or unavailable storage falls through to a clean library.
    }
    return createChartBuilderLibrary();
}

export type CreateLayoutResult =
    | { ok: true; library: ChartBuilderLibrary }
    | { ok: false; reason: "empty" | "duplicate" | "limit" | "invalid" };

export function createChartBuilderLayout(
    library: ChartBuilderLibrary,
    name: string,
    state: BuilderState,
    id: string,
    now = new Date().toISOString(),
): CreateLayoutResult {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    if (library.layouts.length >= MAX_CHART_LAYOUTS)
        return { ok: false, reason: "limit" };
    if (
        library.layouts.some(
            (layout) =>
                layout.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
        )
    ) {
        return { ok: false, reason: "duplicate" };
    }
    const layout: ChartBuilderLayout = {
        id,
        name: trimmed,
        state,
        createdAt: now,
        updatedAt: now,
    };
    const next = {
        ...library,
        activeLayoutId: id,
        layouts: [...library.layouts, layout],
    };
    if (!librarySchema.safeParse(next).success)
        return { ok: false, reason: "invalid" };
    return { ok: true, library: next };
}

export function deleteActiveChartBuilderLayout(
    library: ChartBuilderLibrary,
): ChartBuilderLibrary {
    if (!library.activeLayoutId) return library;
    return {
        ...library,
        activeLayoutId: null,
        layouts: library.layouts.filter(
            (layout) => layout.id !== library.activeLayoutId,
        ),
    };
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

export function encodeSharedChart(state: BuilderState): string {
    const parsed = portableBuilderStateSchema.parse(state);
    const encoded = bytesToBase64Url(
        new TextEncoder().encode(JSON.stringify({ version: 1, state: parsed })),
    );
    if (encoded.length > MAX_SHARED_CHART_LENGTH)
        throw new Error("Shared chart is too large");
    return encoded;
}

export function decodeSharedChart(encoded: string): BuilderState | null {
    if (!encoded || encoded.length > MAX_SHARED_CHART_LENGTH) return null;
    try {
        const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0),
        );
        const parsed = shareSchema.safeParse(
            JSON.parse(new TextDecoder().decode(bytes)),
        );
        return parsed.success ? (parsed.data.state as BuilderState) : null;
    } catch {
        return null;
    }
}
