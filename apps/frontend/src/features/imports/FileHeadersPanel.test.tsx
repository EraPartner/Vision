// @vitest-environment jsdom

/**
 * Tests for FileHeadersPanel.
 *
 * FileReader is stubbed (the component reads the file twice: once to sniff the
 * separator, once via useCsvPreview). Strings resolve through the real English
 * LanguageProvider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { FileHeadersPanel } from "./FileHeadersPanel";
import { detectSeparator } from "./csvSeparator";

function buildFakeFileReader(resultText: string) {
  return class FakeFileReader {
    onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((e: ProgressEvent<FileReader>) => void) | null = null;
    result: string | null = null;
    abort = vi.fn();
    readAsText(_blob: Blob) {
      setTimeout(() => {
        this.result = resultText;
        this.onload?.({} as ProgressEvent<FileReader>);
      }, 0);
    }
  };
}

function buildFakeFileReaderError() {
  return class FakeFileReaderError {
    onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((e: ProgressEvent<FileReader>) => void) | null = null;
    result: string | null = null;
    abort = vi.fn();
    readAsText(_blob: Blob) {
      setTimeout(() => this.onerror?.({} as ProgressEvent<FileReader>), 0);
    }
  };
}

function makeFile(content: string, name = "test.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

function renderPanel(ui: React.ReactElement) {
  return render(
    <LanguageProvider language="en" setLanguage={() => {}}>
      {ui}
    </LanguageProvider>,
  );
}

describe("detectSeparator", () => {
  it("picks the delimiter that yields the most columns", () => {
    expect(detectSeparator("Date;Type;Symbol;Amount")).toBe(";");
    expect(detectSeparator("Date,Type,Symbol")).toBe(",");
    expect(detectSeparator("Date\tType\tSymbol")).toBe("\t");
    expect(detectSeparator("Date|Type|Symbol")).toBe("|");
  });

  it("defaults to comma for a single-column line", () => {
    expect(detectSeparator("OneColumn")).toBe(",");
  });
});

describe("FileHeadersPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when no file is selected", () => {
    const { container } = renderPanel(<FileHeadersPanel file={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows header chips and column count for a selected CSV", async () => {
    const csv = "Date,Type,Symbol,Amount\n2026-01-05,Buy,AAPL,1855";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderPanel(<FileHeadersPanel file={makeFile(csv)} />);

    await waitFor(() => expect(screen.getByText("4 columns")).toBeInTheDocument());
    // Each header appears as a chip (and again in the sample table header).
    expect(screen.getAllByText("Symbol").length).toBeGreaterThan(0);
    expect(screen.getByText("Detected columns")).toBeInTheDocument();
  });

  it("auto-detects a semicolon delimiter and surfaces it", async () => {
    const csv = "Date;Type;Symbol\n2026-01-05;Buy;AAPL";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderPanel(<FileHeadersPanel file={makeFile(csv)} />);

    await waitFor(() =>
      expect(screen.getByText("Detected delimiter: ;")).toBeInTheDocument(),
    );
    expect(screen.getByText("3 columns")).toBeInTheDocument();
  });

  it("does not show a detected-delimiter hint when separator is pinned", async () => {
    const csv = "Date,Type,Symbol\n2026-01-05,Buy,AAPL";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderPanel(<FileHeadersPanel file={makeFile(csv)} separator="," />);

    await waitFor(() => expect(screen.getByText("3 columns")).toBeInTheDocument());
    expect(screen.queryByText(/Detected delimiter/)).not.toBeInTheDocument();
  });

  it("renders the sample-rows table", async () => {
    const csv = "Date,Symbol\n2026-01-05,AAPL\n2026-01-09,MSFT";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    renderPanel(<FileHeadersPanel file={makeFile(csv)} />);

    await waitFor(() => expect(screen.getByText("Sample rows")).toBeInTheDocument());
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("MSFT")).toBeInTheDocument();
  });

  it("degrades to a notice when headers can't be read (empty file)", async () => {
    vi.stubGlobal("FileReader", buildFakeFileReader(""));

    renderPanel(<FileHeadersPanel file={makeFile("", "weird.bin")} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't read columns/)).toBeInTheDocument(),
    );
  });

  it("degrades to a notice when the file read errors", async () => {
    vi.stubGlobal("FileReader", buildFakeFileReaderError());

    renderPanel(<FileHeadersPanel file={makeFile("x", "bad.csv")} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't read columns/)).toBeInTheDocument(),
    );
  });
});
