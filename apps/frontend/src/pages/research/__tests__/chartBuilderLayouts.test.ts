import { describe, expect, it } from "vitest";

import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { DEFAULT_STATE, type BuilderState } from "../chartBuilderState";
import {
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
    it("returns a clean library for absent or malformed v2 storage", () => {
        expect(loadChartBuilderLibrary(memoryStorage())).toEqual(
            createChartBuilderLibrary(),
        );
        const malformed = memoryStorage({
            [LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS]: "{not json",
        });
        expect(loadChartBuilderLibrary(malformed)).toEqual(
            createChartBuilderLibrary(),
        );
        expect(malformed.values.size).toBe(1);
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
