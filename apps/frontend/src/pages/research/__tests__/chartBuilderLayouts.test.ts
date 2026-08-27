import { describe, expect, it } from "vitest";

import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import {
    DEFAULT_STATE,
    STORAGE_KEY as LEGACY_STORAGE_KEY,
    type BuilderState,
} from "../chartBuilderState";
import {
    MAX_CHART_INDICATORS,
    MAX_CHART_LAYOUTS,
    createChartBuilderLayout,
    createChartBuilderLibrary,
    decodeSharedChart,
    deleteActiveChartBuilderLayout,
    encodeSharedChart,
    getActiveBuilderState,
    loadChartBuilderLibrary,
    saveChartBuilderLibrary,
    setActiveBuilderState,
} from "../chartBuilderLayouts";

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        values,
    };
}

const CHART: BuilderState = {
    ...DEFAULT_STATE,
    series: [
        {
            id: "series-1",
            symbol: "BEL20",
            field: "price",
            type: "line",
            axis: "left",
            provider: "",
            macro: {
                provider: "eurostat",
                seriesId: "économie",
                title: "Économie belge",
            },
        },
    ],
    oscillator: "rsi",
    oscillatorSeriesId: "series-1",
};

describe("Chart Builder layout storage", () => {
    it("migrates the legacy draft only after the v2 library is persisted", () => {
        const storage = memoryStorage({
            [LEGACY_STORAGE_KEY]: JSON.stringify(CHART),
        });

        const library = loadChartBuilderLibrary(storage);

        expect(library.draft).toEqual(CHART);
        expect(
            storage.values.has(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS),
        ).toBe(true);
        expect(storage.values.has(LEGACY_STORAGE_KEY)).toBe(false);
    });

    it("keeps the legacy draft when the v2 write fails", () => {
        const storage = {
            getItem: (key: string) =>
                key === LEGACY_STORAGE_KEY ? JSON.stringify(CHART) : null,
            setItem: () => {
                throw new Error("quota");
            },
            removeItem: () => {
                throw new Error("legacy must remain");
            },
        };

        expect(loadChartBuilderLibrary(storage).draft).toEqual(CHART);
    });

    it("caps an oversized legacy indicator list during migration", () => {
        const oversized = {
            ...CHART,
            indicators: Array.from(
                { length: MAX_CHART_INDICATORS + 1 },
                (_, i) => ({
                    id: `indicator-${i}`,
                    type: "sma" as const,
                    period: 20,
                    seriesId: "series-1",
                }),
            ),
        };
        const storage = memoryStorage({
            [LEGACY_STORAGE_KEY]: JSON.stringify(oversized),
        });

        const library = loadChartBuilderLibrary(storage);

        expect(library.draft.indicators).toHaveLength(MAX_CHART_INDICATORS);
        expect(
            storage.values.has(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS),
        ).toBe(true);
    });

    it("creates, edits and deletes named layouts without losing the draft", () => {
        const original = createChartBuilderLibrary(CHART);
        const created = createChartBuilderLayout(
            original,
            "Belgian outlook",
            CHART,
            "layout-1",
            "2026-08-27T10:00:00.000Z",
        );
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const editedState = { ...CHART, range: "5y" as const };
        const edited = setActiveBuilderState(
            created.library,
            editedState,
            "2026-08-27T11:00:00.000Z",
        );
        expect(getActiveBuilderState(edited)).toEqual(editedState);
        expect(edited.draft).toEqual(CHART);

        const deleted = deleteActiveChartBuilderLayout(edited);
        expect(deleted.layouts).toEqual([]);
        expect(deleted.activeLayoutId).toBeNull();
        expect(getActiveBuilderState(deleted)).toEqual(CHART);
    });

    it("rejects duplicate names and enforces the layout cap", () => {
        let library = createChartBuilderLibrary(CHART);
        for (let index = 0; index < MAX_CHART_LAYOUTS; index += 1) {
            const result = createChartBuilderLayout(
                library,
                `Layout ${index}`,
                CHART,
                `layout-${index}`,
            );
            expect(result.ok).toBe(true);
            if (result.ok) library = result.library;
        }

        expect(
            createChartBuilderLayout(library, "layout 0", CHART, "duplicate"),
        ).toMatchObject({ ok: false, reason: "limit" });
        expect(
            createChartBuilderLayout(
                library,
                "One more",
                CHART,
                "layout-over-limit",
            ),
        ).toMatchObject({ ok: false, reason: "limit" });

        const one = createChartBuilderLayout(
            createChartBuilderLibrary(CHART),
            "Named",
            CHART,
            "one",
        );
        expect(one.ok).toBe(true);
        if (one.ok) {
            expect(
                createChartBuilderLayout(one.library, " named ", CHART, "two"),
            ).toMatchObject({ ok: false, reason: "duplicate" });
        }
    });

    it("round-trips Unicode share state and rejects invalid references", () => {
        expect(decodeSharedChart(encodeSharedChart(CHART))).toEqual(CHART);

        const invalid = {
            ...CHART,
            oscillatorSeriesId: "missing",
        };
        expect(() => encodeSharedChart(invalid)).toThrow();
        expect(decodeSharedChart("not-valid-base64")).toBeNull();
    });

    it("does not persist invalid libraries", () => {
        const storage = memoryStorage();
        const invalid = {
            ...createChartBuilderLibrary(CHART),
            activeLayoutId: "missing",
        };
        expect(saveChartBuilderLibrary(invalid, storage)).toBe(false);
        expect(storage.values.size).toBe(0);
    });
});
