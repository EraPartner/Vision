// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import ChartBuilderPage from "@/pages/research/ChartBuilderPage";
import {
    STORAGE_KEY,
    type BuilderState,
} from "@/pages/research/chartBuilderState";
import { encodeSharedChart } from "@/pages/research/chartBuilderLayouts";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

const queryState = vi.hoisted(() => ({ loading: true }));

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@tanstack/react-query")>();
    return {
        ...actual,
        useQuery: () => ({ data: undefined }),
        useQueries: () => [
            queryState.loading
                ? { isFetching: true, data: undefined }
                : { isFetching: false, data: { data: { points: [] } } },
        ],
    };
});

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/stores/hydration/LanguageHydration")>();
    const { default: en } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string) => en[key] ?? key,
        }),
    };
});

vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({
        appSettings: { numberFormat: "en-US", dateFormat: "yyyy-MM-dd" },
    }),
}));

vi.mock("@/hooks/useSymbolSearch", () => ({
    useSymbolSearch: () => ({
        searchText: "",
        setSearchText: vi.fn(),
        debouncedSearch: "",
        searchResult: undefined,
        isOpen: false,
    }),
}));

vi.mock("@/components/charts", () => ({
    ComposedChart: () => <div data-testid="composed-chart" />,
    LineChart: () => <div data-testid="line-chart" />,
    getChartColor: () => "currentColor",
}));

const STORED_STATE: BuilderState = {
    range: "1y",
    logLeft: false,
    rebase: false,
    series: [
        {
            id: "series-1",
            symbol: "TEST",
            field: "price",
            type: "line",
            axis: "left",
            provider: "",
        },
    ],
    indicators: [],
    oscillator: "rsi",
    oscillatorSeriesId: "series-1",
};

let storageValues: Map<string, string>;

function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{location.search}</div>;
}

function renderPage(initialEntry = "/research/charts") {
    return render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <ChartBuilderPage />
            <LocationProbe />
        </MemoryRouter>,
    );
}

describe("ChartBuilderPage oscillator state", () => {
    beforeEach(() => {
        storageValues = new Map([[STORAGE_KEY, JSON.stringify(STORED_STATE)]]);
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storageValues.get(key) ?? null,
            setItem: (key: string, value: string) =>
                storageValues.set(key, value),
            removeItem: (key: string) => storageValues.delete(key),
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it("announces one loading surface for the shared chart query", () => {
        queryState.loading = true;
        renderPage();

        expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("replaces loading bones with compact settled empty states", () => {
        queryState.loading = false;
        renderPage();

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getAllByText("No chart data available")).toHaveLength(2);
    });

    it("saves and deletes a named layout through the rendered controls", async () => {
        const user = userEvent.setup();
        renderPage();

        await user.click(screen.getByRole("button", { name: /save as/i }));
        await user.type(screen.getByLabelText(/layout name/i), "Belgian view");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        expect(screen.getByText("Belgian view")).toBeInTheDocument();
        const stored = JSON.parse(
            storageValues.get(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS) ?? "{}",
        );
        expect(stored.layouts).toHaveLength(1);

        await user.click(screen.getByRole("button", { name: /^delete$/i }));
        await user.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
                name: /^delete$/i,
            }),
        );
        expect(screen.queryByText("Belgian view")).not.toBeInTheDocument();
    });

    it("preserves an unnamed draft until a shared-chart replacement is confirmed", async () => {
        const user = userEvent.setup();
        const shared = encodeSharedChart({
            ...STORED_STATE,
            series: [
                {
                    ...STORED_STATE.series[0],
                    id: "shared-series",
                    symbol: "SHARED",
                },
            ],
            oscillatorSeriesId: "shared-series",
        });
        renderPage(`/research/charts?keep=1&chart=${shared}`);

        expect(
            await screen.findByRole("heading", {
                name: /replace unnamed draft/i,
            }),
        ).toBeInTheDocument();
        expect(screen.getByText("TEST")).toBeInTheDocument();
        expect(screen.getByTestId("location")).toHaveTextContent("?keep=1");

        await user.click(
            screen.getByRole("button", { name: /open shared chart/i }),
        );
        expect(await screen.findByText("SHARED")).toBeInTheDocument();
        expect(screen.queryByText("TEST")).not.toBeInTheDocument();
    });

    it("removes an invalid share payload while preserving unrelated parameters", async () => {
        renderPage("/research/charts?keep=1&chart=invalid");

        await vi.waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "This shared chart link is invalid or too large.",
            ),
        );
        expect(screen.getByTestId("location")).toHaveTextContent("?keep=1");
        expect(screen.getByText("TEST")).toBeInTheDocument();
    });

    it("surfaces local layout-storage failures", async () => {
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storageValues.get(key) ?? null,
            setItem: () => {
                throw new Error("quota");
            },
            removeItem: (key: string) => storageValues.delete(key),
        });

        renderPage();

        await vi.waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Chart changes could not be saved on this device.",
            ),
        );
    });

    it("disables new indicators at the persisted limit", () => {
        storageValues.set(
            STORAGE_KEY,
            JSON.stringify({
                ...STORED_STATE,
                indicators: Array.from({ length: 20 }, (_, index) => ({
                    id: `indicator-${index}`,
                    type: "sma",
                    period: 20,
                    seriesId: "series-1",
                })),
            }),
        );

        renderPage();

        expect(screen.getByRole("button", { name: "SMA" })).toBeDisabled();
    });
});
