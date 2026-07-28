// @vitest-environment jsdom

/**
 * Tests for PortfolioCsvColumnMapper. FileReader is stubbed (the mapper reads
 * the file via useCsvPreview to populate its column dropdowns). The file's
 * columns are shown by the parent-owned FileHeadersPanel, covered separately in
 * FileHeadersPanel.test.tsx. Strings resolve through the real English
 * LanguageProvider. Radix Select portals are not opened — assertions target
 * observable output (fallback inputs vs dropdowns, type-mapping seeding).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { PortfolioCsvColumnMapper } from "./PortfolioCsvColumnMapper";
import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";

function buildFakeFileReader(resultText: string) {
  return class FakeFileReader {
    onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((e: ProgressEvent<FileReader>) => void) | null = null;
    result: string | null = null;
    abort = vi.fn();
    readAsText() {
      setTimeout(() => {
        this.result = resultText;
        this.onload?.({} as ProgressEvent<FileReader>);
      }, 0);
    }
  };
}

function makeFile(content: string): File {
  return new File([content], "trades.csv", { type: "text/csv" });
}

function baseConfig(overrides: Partial<PortfolioCustomConfig> = {}): PortfolioCustomConfig {
  return {
    dateColumn: "", typeColumn: "", symbolColumn: "", nameColumn: "",
    unitsColumn: "", priceColumn: "", amountColumn: "", feesColumn: "", taxesColumn: "",
    currencyColumn: "", fxRateColumn: "", noteColumn: "",
    dateFormat: "%Y-%m-%d", separator: ",", encoding: "utf-8", skipRows: 0,
    defaultAssetClass: "stock", defaultType: "buy", typeMapping: {},
    ...overrides,
  };
}

function renderMapper(file: File | null, config: PortfolioCustomConfig) {
  return render(
    <LanguageProvider language="en" setLanguage={() => {}}>
      <PortfolioCsvColumnMapper file={file} separator={config.separator} config={config} onChange={() => {}} />
    </LanguageProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PortfolioCsvColumnMapper", () => {
  it("falls back to text inputs when no file is selected", async () => {
    renderMapper(null, baseConfig());
    // LanguageProvider loads the locale async; wait for the translated note.
    expect(await screen.findByText(/Required\. Map a date column/)).toBeInTheDocument();
    // Without headers the 12 column fields render as plain text inputs.
    expect(screen.getAllByRole("textbox")).toHaveLength(12);
  });

  it("swaps the text inputs for column dropdowns once the file's headers load", async () => {
    const csv = "Date,Type,Symbol,Qty,Price\n2026-01-05,Buy,AAPL,10,185.50";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderMapper(makeFile(csv), baseConfig());

    // Once headers are known the 12 column fields render as Radix selects
    // (comboboxes), not text inputs.
    await waitFor(() => expect(screen.queryAllByRole("textbox")).toHaveLength(0));
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });

  it("seeds the type-mapping editor from distinct values in the chosen type column", async () => {
    const csv = "Date,Type,Symbol\n2026-01-05,Buy,AAPL\n2026-01-09,Sell,AAPL";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderMapper(makeFile(csv), baseConfig({ typeColumn: "Type" }));

    await waitFor(() => expect(screen.getByText("Map transaction types")).toBeInTheDocument());
    // Distinct raw type values from the preview rows are listed ("Buy" also
    // shows in the default-type trigger, hence getAllByText).
    expect(screen.getAllByText("Buy").length).toBeGreaterThan(0);
    expect(screen.getByText("Sell")).toBeInTheDocument();
  });

  it("warns when the same CSV column is mapped to multiple fields", async () => {
    // amount + fees both mapped to "Amount" → every row would get fees = amount.
    renderMapper(null, baseConfig({ dateColumn: "Date", amountColumn: "Amount", feesColumn: "Amount" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /The same CSV column is mapped to multiple fields: Amount/,
    );
  });

  it("shows no duplicate warning when every mapped column is distinct", async () => {
    renderMapper(null, baseConfig({ dateColumn: "Date", amountColumn: "Amount", feesColumn: "Fees" }));

    expect(await screen.findByText(/Required\. Map a date column/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
