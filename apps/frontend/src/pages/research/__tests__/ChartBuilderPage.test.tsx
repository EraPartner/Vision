// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import ChartBuilderPage from "@/pages/research/ChartBuilderPage";
import type { BuilderState } from "@/pages/research/chartBuilderState";
import {
    createChartBuilderLibrary,
    encodeSharedChart,
} from "@/pages/research/chartBuilderLayouts";
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
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: en } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string, vars?: Record<string, string | number>) =>
                (en[key] ?? key).replace(
                    /\{(\w+)\}/g,
                    (match: string, name: string) =>
                        vars && name in vars ? String(vars[name]) : match,
                ),
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
        storageValues = new Map([
            [
                LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS,
                JSON.stringify(createChartBuilderLibrary(STORED_STATE)),
            ],
        ]);
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storageValues.get(key) ?? null,
            setItem: (key: string, value: string) =>
                storageValues.set(key, value),
            removeItem: (key: string) => storageValues.delete(key),
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it("names series controls and supports changing the axis from the keyboard", async () => {
        const user = userEvent.setup();
        renderPage();
        expect(
            screen.getByRole("combobox", { name: "Chart type: TEST" }),
        ).toHaveTextContent("Line");
        expect(
            screen.getByRole("combobox", { name: "Data provider: TEST" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("combobox", { name: "Oscillator" }),
        ).toHaveTextContent("RSI");
        const axis = screen.getByRole("combobox", { name: "Axis: TEST" });
        axis.focus();
        await user.keyboard(" ");
        await user.keyboard("{End}{Enter}");
        expect(axis).toHaveTextContent("Right axis");
        await user.click(
            screen.getByRole("button", { name: "Actions for TEST" }),
        );
        await user.click(
            within(await screen.findByRole("menu")).getByRole("menuitem", {
                name: "Remove series",
            }),
        );
        expect(
            screen.queryByRole("combobox", { name: "Axis: TEST" }),
        ).not.toBeInTheDocument();
    });

    it("announces one loading surface for the shared chart query", () => {
        queryState.loading = true;
        renderPage();

        expect(
            screen.getAllByRole("status", { name: /loading/i }),
        ).toHaveLength(1);
        expect(
            screen.getByText("Changes saved on this device"),
        ).toBeInTheDocument();
    });

    it("replaces loading bones with compact settled empty states", () => {
        queryState.loading = false;
        renderPage();

        expect(
            screen.queryByRole("status", { name: /loading/i }),
        ).not.toBeInTheDocument();
        expect(screen.getAllByText("No chart data available")).toHaveLength(2);
    });

    it("keeps chart options collapsed and preserves scale choices", async () => {
        const user = userEvent.setup();
        renderPage();
        const options = screen.getByText("Chart options").closest("details")!;
        expect(options).not.toHaveAttribute("open");
        await user.click(screen.getByText("Chart options"));
        const scale = screen.getByRole("switch", { name: "Log scale" });
        await user.click(scale);
        await user.click(screen.getByText("Chart options"));
        expect(options).not.toHaveAttribute("open");
        expect(options.querySelector("summary")).toHaveTextContent("Log scale");
        await user.click(screen.getByText("Chart options"));
        expect(scale).toBeChecked();
    });

    it("saves a named layout and deletes it from the page menu with Undo", async () => {
        const user = userEvent.setup();
        renderPage();

        await user.click(screen.getByRole("button", { name: /save as/i }));
        await user.type(screen.getByLabelText(/layout name/i), "Belgian view");
        await user.click(screen.getByRole("button", { name: /save layout/i }));

        expect(screen.getByText("Belgian view")).toBeInTheDocument();
        const stored = JSON.parse(
            storageValues.get(LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS) ?? "{}",
        );
        expect(stored.layouts).toHaveLength(1);

        await user.click(screen.getByRole("button", { name: "More actions" }));
        await user.click(
            within(await screen.findByRole("menu")).getByRole("menuitem", {
                name: "Delete saved layout",
            }),
        );
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(screen.queryByText("Belgian view")).not.toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith(
            "Layout deleted",
            expect.objectContaining({
                action: expect.objectContaining({ label: "Undo" }),
            }),
        );

        const undo = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as unknown as {
            action: { onClick: () => void };
        };
        undo.action.onClick();
        expect(await screen.findByText("Belgian view")).toBeInTheDocument();
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
        expect(
            await screen.findByText(
                "Chart changes could not be saved on this device.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Changes saved on this device"),
        ).not.toBeInTheDocument();

        await vi.waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Chart changes could not be saved on this device.",
            ),
        );
    });

    it("disables new indicators at the persisted limit", () => {
        storageValues.set(
            LOCAL_STORAGE_KEYS.CHART_BUILDER_LAYOUTS,
            JSON.stringify(
                createChartBuilderLibrary({
                    ...STORED_STATE,
                    indicators: Array.from({ length: 20 }, (_, index) => ({
                        id: `indicator-${index}`,
                        type: "sma",
                        period: 20,
                        seriesId: "series-1",
                    })),
                }),
            ),
        );

        renderPage();

        expect(screen.getByRole("button", { name: "SMA" })).toBeDisabled();
    });
});
