// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ChartBuilderPage from "@/pages/research/ChartBuilderPage";
import { STORAGE_KEY, type BuilderState } from "@/pages/research/chartBuilderState";

const queryState = vi.hoisted(() => ({ loading: true }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
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

vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/LanguageContext")>();
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

vi.mock("@/contexts/AppSettingsContext", () => ({
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

describe("ChartBuilderPage oscillator state", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === STORAGE_KEY ? JSON.stringify(STORED_STATE) : null,
      setItem: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("announces one loading surface for the shared chart query", () => {
    queryState.loading = true;
    render(<ChartBuilderPage />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("replaces loading bones with compact settled empty states", () => {
    queryState.loading = false;
    render(<ChartBuilderPage />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getAllByText("No chart data available")).toHaveLength(2);
  });
});
