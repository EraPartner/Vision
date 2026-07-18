// @vitest-environment jsdom

/**
 * Tests for useCsvPreview hook.
 *
 * Uses renderHook + waitFor from @testing-library/react.
 * FileReader is stubbed via vi.stubGlobal with a class-based implementation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCsvPreview } from "./useCsvPreview";

// ── FileReader stub ────────────────────────────────────────────────────────────

/** Build a FileReader class whose readAsText fires onload synchronously (via setTimeout 0). */
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

/** Build a FileReader class whose readAsText fires onerror. */
function buildFakeFileReaderError() {
  return class FakeFileReaderError {
    onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((e: ProgressEvent<FileReader>) => void) | null = null;
    result: string | null = null;
    abort = vi.fn();

    readAsText(_blob: Blob) {
      setTimeout(() => {
        this.onerror?.({} as ProgressEvent<FileReader>);
      }, 0);
    }
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFile(content: string, name = "test.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useCsvPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null preview when file is null", () => {
    const { result } = renderHook(() => useCsvPreview(null, ","));
    expect(result.current.preview).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("parses headers and preview rows from CSV text", async () => {
    const csv = `Date,Recipient,Amount\n2026-01-01,Netflix,-12.99\n2026-01-02,Spotify,-9.99`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview).toMatchObject({
      headers: ["Date", "Recipient", "Amount"],
      rows: [
        ["2026-01-01", "Netflix", "-12.99"],
        ["2026-01-02", "Spotify", "-9.99"],
      ],
    });
    expect(result.current.error).toBeNull();
  });

  it("respects alternative separator (semicolon)", async () => {
    const csv = `Date;Recipient;Amount\n2026-01-01;Netflix;-12.99`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ";"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.headers).toEqual(["Date", "Recipient", "Amount"]);
    expect(result.current.preview?.rows[0]).toEqual(["2026-01-01", "Netflix", "-12.99"]);
  });

  it("handles quoted fields containing the separator", async () => {
    const csv = `Name,Memo\n"Smith, John","Payment for invoice #1"`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows[0]).toEqual(["Smith, John", "Payment for invoice #1"]);
  });

  it("limits preview to MAX_PREVIEW_ROWS (5) rows", async () => {
    const dataRows = Array.from(
      { length: 10 },
      (_, i) => `2026-01-${String(i + 1).padStart(2, "0")},R${i},-1.00`,
    );
    const csv = ["Date,Recipient,Amount", ...dataRows].join("\n");
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows).toHaveLength(5);
  });

  it("skips rows whose column count differs from the header", async () => {
    const csv = `Date,Amount\n2026-01-01,-1.00,EXTRA\n2026-01-02,-2.00`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows).toEqual([["2026-01-02", "-2.00"]]);
  });

  it("handles quoted fields with embedded newlines", async () => {
    const csv = `Name,Memo\n"Smith, John","line one\nline two"\n2026-01-02,x`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows).toEqual([
      ["Smith, John", "line one\nline two"],
      ["2026-01-02", "x"],
    ]);
  });

  it("keeps escaped double-quotes inside quoted fields", async () => {
    const csv = `Name,Memo\n"Smith","said ""hi"" twice"`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows).toEqual([["Smith", 'said "hi" twice']]);
  });

  it("survives a tail truncated mid-quote (PEEK_BYTES cut)", async () => {
    // Simulates the preview slice ending inside an open quoted field: the
    // records before the cut must still preview, and the truncated record is
    // treated as if the quote closed at the cut (it still has both columns
    // here, so it stays — a partial record missing columns is dropped by the
    // column-count check like any other short row).
    const csv = `Date,Memo\n2026-01-01,ok\n2026-01-02,"cut off mid-quo`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.preview?.headers).toEqual(["Date", "Memo"]);
    expect(result.current.preview?.rows).toEqual([
      ["2026-01-01", "ok"],
      ["2026-01-02", "cut off mid-quo"],
    ]);
  });

  it("trims whitespace around fields, including inside quotes", async () => {
    const csv = `Date , Amount \n 2026-01-01 ,"  -1.00  "`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.headers).toEqual(["Date", "Amount"]);
    expect(result.current.preview?.rows).toEqual([["2026-01-01", "-1.00"]]);
  });

  it("skips blank lines in data rows", async () => {
    const csv = `Date,Amount\n2026-01-01,-1.00\n\n2026-01-02,-2.00`;
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.preview?.rows).toHaveLength(2);
  });

  it("returns error state when FileReader fires onerror", async () => {
    vi.stubGlobal("FileReader", buildFakeFileReaderError());

    const file = makeFile("", "bad.csv");
    const { result } = renderHook(() => useCsvPreview(file, ","));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("read_error");
    expect(result.current.preview).toBeNull();
  });

  it("clears preview when file is set back to null", async () => {
    const csv = "Date,Amount\n2026-01-01,-1.00";
    vi.stubGlobal("FileReader", buildFakeFileReader(csv));

    const file = makeFile(csv);
    const { result, rerender } = renderHook(
      ({ f }: { f: File | null }) => useCsvPreview(f, ","),
      { initialProps: { f: file as File | null } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.preview).not.toBeNull();

    rerender({ f: null });
    expect(result.current.preview).toBeNull();
  });
});
