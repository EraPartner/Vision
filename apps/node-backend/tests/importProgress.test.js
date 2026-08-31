import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSubject() {
  vi.resetModules();
  const writer = {
    closed: false,
    write: vi.fn().mockResolvedValue(undefined),
    end: vi.fn(),
  };
  const cleanup = vi.fn();
  const logger = { error: vi.fn() };

  vi.doMock("../src/lib/sse.js", () => ({
    createSseWriter: vi.fn(() => writer),
  }));
  vi.doMock("../src/lib/csvUpload.js", () => ({ cleanup }));
  vi.doMock("../src/config/logger.js", () => ({ logger }));

  const subject = await import("../src/lib/importProgress.js");
  const { ValidationError } = await import("../src/middleware/errorHandler.js");
  return { ...subject, ValidationError, writer, cleanup };
}

describe("streamImport terminal events", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("emits complete for a successful import", async () => {
    const { streamImport, writer, cleanup } = await loadSubject();

    await streamImport(
      {},
      {},
      {
        filePath: "/tmp/import.csv",
        errorLogMessage: "failed",
        run: vi.fn().mockResolvedValue({ errors: 0, imported: 2 }),
        buildComplete: (result) => ({ imported: result.imported }),
      },
    );

    expect(writer.write).toHaveBeenCalledWith("complete", {
      imported: 2,
      status: "completed",
      percent: 100,
    });
    expect(writer.end).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("/tmp/import.csv");
  });

  it("adds VALIDATION_ERROR to an actionable validation failure", async () => {
    const { streamImport, ValidationError, writer } = await loadSubject();

    await streamImport(
      {},
      {},
      {
        filePath: "/tmp/import.csv",
        errorLogMessage: "failed",
        run: vi
          .fn()
          .mockRejectedValue(new ValidationError("date_column is required")),
        buildComplete: vi.fn(),
      },
    );

    expect(writer.write).toHaveBeenCalledWith("error", {
      detail: "date_column is required",
      code: "VALIDATION_ERROR",
    });
  });

  it("sanitizes unexpected failures and adds INTERNAL_SERVER_ERROR", async () => {
    const { streamImport, writer } = await loadSubject();

    await streamImport(
      {},
      {},
      {
        filePath: "/tmp/import.csv",
        errorLogMessage: "failed",
        run: vi.fn().mockRejectedValue(new Error("database password leaked")),
        buildComplete: vi.fn(),
      },
    );

    expect(writer.write).toHaveBeenCalledWith("error", {
      detail: "Import failed",
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(JSON.stringify(writer.write.mock.calls)).not.toContain("password");
  });
});
