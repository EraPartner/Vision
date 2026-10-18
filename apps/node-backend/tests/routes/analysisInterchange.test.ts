import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import {
  analysisResultWorkbook,
  importAnalysisWorkbook,
} from "@vision/shared-utils/analysis/workbook";
import { analysisResultCsv } from "@vision/shared-utils/analysis/interchange";
import type { AnalysisInterchangeResult } from "@vision/shared-utils/analysis/types";
import { parseAnalysisWorkbookXml } from "../../src/services/analysisWorkbookXml.ts";
import router from "../../src/routes/analysisInterchange.ts";

// Extend the repository's minimal supertest declaration for binary response tests.
declare module "supertest" {
  interface Test {
    buffer(value: boolean): this;
    parse(
      parser: (
        response: IncomingMessage,
        callback: (error: Error | null, data?: Buffer) => void,
      ) => void,
    ): this;
  }
}

const api = routeAgent(router, { mountPath: "/api/analysis" });
const path = "/api/analysis/interchange";
const result: AnalysisInterchangeResult = {
  requestId: "fixture-captured",
  startedAt: "2026-10-13T10:00:00Z",
  completedAt: "2026-10-13T10:00:01Z",
  executor: "postgresql-role-v1",
  columns: [
    { id: "date", type: "date" },
    { id: "amount", type: "decimal" },
    { id: "identifier", type: "string" },
    { id: "note", type: "string" },
  ],
  rows: [
    {
      date: "1900-01-01",
      amount: "-12.30",
      identifier: "9007199254740993",
      note: "=SUM(A1) & <tag>",
    },
  ],
  formulaSummaries: { exact: "1234567890123456.78" },
  coverage: { complete: false, status: "partial", unavailableRows: 1 },
  transformationErrors: [{ message: "source missing" }],
  window: {
    kind: "page",
    offset: 0,
    limit: 500,
    returnedRows: 1,
    hasMore: false,
  },
};
const context = {
  name: "Synthetic",
  timezone: "UTC",
  workspace: "budgeting",
  assumptions: {
    definitions: [{ id: "rate", defaultValue: "0.1" }],
    values: { rate: "0.25" },
  },
  formulas: [{ id: "sum", expression: "amount + 1" }],
};
function exportRequest(
  format: string,
  snapshot: unknown = { result, context },
) {
  return api
    .post(`${path}/export`)
    .field("format", format)
    .attach("file", Buffer.from(JSON.stringify(snapshot)), "snapshot.json");
}
function binaryParser(
  response: IncomingMessage,
  callback: (error: Error | null, data?: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  response.on("end", () => {
    callback(null, Buffer.concat(chunks));
  });
}
function responseBytes(response: { body: unknown }): Buffer {
  if (!Buffer.isBuffer(response.body))
    throw new Error("Expected binary response");
  return response.body;
}
function storedSheet(source: string, method = 0) {
  const name = Buffer.from("xl/worksheets/sheet1.xml"),
    bytes = Buffer.from(source);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return Buffer.concat([header, bytes]);
}
describe("read-only Analysis interchange", () => {
  it("returns exact CSV typed values, unsafe IDs and decoded-text SHA with stable replacement identity", async () => {
    const text =
      "Name,Cost,Account,Enabled,Date\nPlan,40.500,9007199254740993,true,2026-10-13\n";
    const first = await api
      .post(`${path}/import`)
      .field("format", "csv")
      .attach("file", Buffer.from(text), "scenario.csv");
    expect(first.status).toBe(200);
    const hash = createHash("sha256").update(text).digest("hex");
    expect(bodyAt(first, "data", "attachment", "id")).toBe(
      `scenario_${hash.slice(0, 12)}`,
    );
    expect(bodyAt(first, "data", "attachment", "sha256")).toBe(hash);
    expect(bodyAt(first, "data", "attachment", "rows", 0)).toEqual({
      name: "Plan",
      cost: "40.500",
      account: "9007199254740993",
      enabled: true,
      date: "2026-10-13",
    });
    expect(bodyAt(first, "data", "attachment", "columns", 2)).toEqual({
      id: "account",
      label: "Account",
      type: "string",
    });
    expect(bodyAt(first, "data", "formulaCells")).toBe(0);
    const repeat = await api
      .post(`${path}/import`)
      .field("format", "csv")
      .attach("file", Buffer.from(text), "renamed.csv");
    expect(bodyAt(repeat, "data", "attachment", "id")).toBe(
      bodyAt(first, "data", "attachment", "id"),
    );
  });
  it("retains File.text UTF-8 decoding/BOM semantics in the CSV digest", async () => {
    const bytes = Buffer.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from("A\n"),
      0xff,
      10,
    ]);
    const response = await api
      .post(`${path}/import`)
      .field("format", "csv")
      .attach("file", bytes, "encoded.csv");
    expect(response.status).toBe(200);
    expect(bodyAt(response, "data", "attachment", "sha256")).toBe(
      createHash("sha256")
        .update(new TextDecoder().decode(bytes))
        .digest("hex"),
    );
    expect(bodyAt(response, "data", "attachment", "rows", 0)).toEqual({
      a: "\ufffd",
    });
  });
  it("imports workbook provenance IDs, exact long decimal text, calendar dates and fresh append identity", async () => {
    const snapshot = {
      ...result,
      declaredColumns: result.columns.map((column) => ({
        ...column,
        label: `Display ${column.id}`,
        unit: { kind: "money", currency: "EUR" },
      })),
    };
    const bytes = analysisResultWorkbook(snapshot, context);
    const response = await api
      .post(`${path}/import`)
      .field("format", "xlsx")
      .attach("file", Buffer.from(bytes), "snapshot.xlsx");
    expect(response.status).toBe(200);
    expect(bodyAt(response, "data", "attachment", "rows", 0)).toEqual({
      date: "1900-01-01",
      amount: -12.3,
      identifier: "9007199254740993",
      note: "=SUM(A1) & <tag>",
    });
    expect(bodyAt(response, "data", "attachment", "columns", 1)).toEqual({
      id: "amount",
      label: "amount",
      type: "decimal",
    });
    expect(bodyAt(response, "data", "attachment", "sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const repeat = await api
      .post(`${path}/import`)
      .field("format", "xlsx")
      .attach("file", Buffer.from(bytes), "snapshot.xlsx");
    expect(bodyAt(repeat, "data", "attachment", "id")).not.toBe(
      bodyAt(response, "data", "attachment", "id"),
    );
    expect(bodyAt(response, "data", "formulaCells")).toBe(0);
  });
  it("counts ignored formula cells without evaluating cached results", async () => {
    const bytes = storedSheet(
      '<worksheet><sheetData><row><c t="inlineStr"><is><t>value</t></is></c></row><row><c><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
    );
    const response = await api
      .post(`${path}/import`)
      .field("format", "xlsx")
      .attach("file", bytes, "formula.xlsx");
    expect(response.status).toBe(200);
    expect(bodyAt(response, "data", "formulaCells")).toBe(1);
    expect(bodyAt(response, "data", "attachment", "rows", 0)).toEqual({
      value: null,
    });
  });
  it("exports byte-identical captured workbook and preserves absence of optional context metadata", async () => {
    const response = await exportRequest("xlsx")
      .buffer(true)
      .parse(binaryParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toContain("analysis.xlsx");
    expect(responseBytes(response)).toEqual(
      Buffer.from(analysisResultWorkbook(result, context)),
    );
    const text = new TextDecoder().decode(responseBytes(response));
    for (const value of [
      "financialCoverage",
      "source missing",
      "1234567890123456.78",
      "Formula definitions",
      "0.25",
    ])
      expect(text).toContain(value);
    expect(text).not.toContain("<f>");
  });
  it("exports the exact CSV formula protection and reproducibility metadata", async () => {
    const fullContext = {
      ...context,
      datasetIds: ["cash-flows"],
      sourceReferences: ["Synthetic Demo"],
    };
    const response = await exportRequest("csv", {
      result,
      context: fullContext,
    })
      .buffer(true)
      .parse(binaryParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(responseBytes(response).toString()).toBe(
      analysisResultCsv(result, fullContext),
    );
    expect(responseBytes(response).toString()).toContain("'=SUM(A1)");
  });
  it("preserves captured JSON/array cells and currency in both shared/browser-compatible exports", async () => {
    const captured = {
      ...result,
      columns: [
        { id: "currency", type: "string" },
        { id: "category_path_ids", type: "array" },
        { id: "details", type: "json" },
        { id: "amount", type: "decimal" },
      ],
      rows: [
        {
          currency: "USD",
          category_path_ids: [1, "9007199254740993", null],
          details: { note: "=1+1", unavailable: null, enabled: false },
          amount: "-12.3000",
        },
      ],
    };
    const fullContext = { ...context, datasetIds: [], sourceReferences: [] };
    const csv = await exportRequest("csv", {
      result: captured,
      context: fullContext,
    })
      .buffer(true)
      .parse(binaryParser);
    expect(csv.status).toBe(200);
    expect(responseBytes(csv).toString()).toBe(
      analysisResultCsv(captured, fullContext),
    );
    expect(responseBytes(csv).toString()).toContain("USD");
    expect(responseBytes(csv).toString()).toContain("-12.3000");
    const xlsx = await exportRequest("xlsx", {
      result: captured,
      context: fullContext,
    })
      .buffer(true)
      .parse(binaryParser);
    expect(xlsx.status).toBe(200);
    expect(responseBytes(xlsx)).toEqual(
      Buffer.from(analysisResultWorkbook(captured, fullContext)),
    );
    expect(new TextDecoder().decode(responseBytes(xlsx))).not.toContain("<f>");
    expect(
      importAnalysisWorkbook(responseBytes(xlsx), parseAnalysisWorkbookXml)
        .rows[0],
    ).toMatchObject({
      currency: "USD",
      category_path_ids: '[1,"9007199254740993",null]',
      details: '{"note":"=1+1","unavailable":null,"enabled":false}',
    });
  });
  it("supports 100,000-row export beyond the global JSON body limit without truncation", async () => {
    const large = {
      ...result,
      columns: [{ id: "amount", type: "decimal" }],
      rows: Array.from({ length: 100000 }, () => ({ amount: "12.30" })),
    };
    expect(
      Buffer.byteLength(JSON.stringify({ result: large, context })),
    ).toBeGreaterThan(1000000);
    const response = await exportRequest("xlsx", { result: large, context })
      .buffer(true)
      .parse(binaryParser);
    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(responseBytes(response));
    expect(text).toContain('<row r="100001">');
    expect(text).not.toContain('<row r="100002">');
  });
  it("rejects workbook export above its existing row limit", async () => {
    const large = {
      ...result,
      rows: Array.from({ length: 100001 }, () => ({ amount: "1" })),
    };
    const response = await exportRequest("xlsx", { result: large, context });
    expect(response.status).toBe(400);
    expect(bodyAt(response, "error", "message")).toContain("100,000");
  });
  it.each([
    ["duplicate normalized columns", "A!,A?\n1,2\n"],
    ["bad row width", "A,B\n1\n"],
    ["header only", "A\n"],
    [
      "column cap",
      Array.from({ length: 33 }, (_, i) => `A${i}`).join(",") +
        "\n" +
        Array(33).fill("1").join(","),
    ],
    ["row cap", "A\n" + "1\n".repeat(1001)],
  ])("rejects CSV %s", async (_label, source) => {
    expect(
      (
        await api
          .post(`${path}/import`)
          .field("format", "csv")
          .attach("file", Buffer.from(source), "scenario.csv")
      ).status,
    ).toBe(400);
  });
  it("rejects oversized CSV and workbook imports with validation envelopes", async () => {
    const csv = await api
      .post(`${path}/import`)
      .field("format", "csv")
      .attach("file", Buffer.alloc(1000001), "large.csv");
    expect(csv.status).toBe(400);
    const xlsx = await api
      .post(`${path}/import`)
      .field("format", "xlsx")
      .attach("file", Buffer.alloc(10000001), "large.xlsx");
    expect(xlsx.status).toBe(400);
  });
  it("retains attachment row/column caps after parsing a supported workbook", async () => {
    const rows = {
      ...result,
      rows: Array.from({ length: 1001 }, () => ({ amount: "1" })),
    };
    const columns = {
      ...result,
      columns: Array.from({ length: 33 }, (_, i) => ({
        id: `c${i}`,
        type: "string",
      })),
      rows: [{ c0: "x" }],
    };
    for (const snapshot of [rows, columns]) {
      const response = await api
        .post(`${path}/import`)
        .field("format", "xlsx")
        .attach(
          "file",
          Buffer.from(analysisResultWorkbook(snapshot, context)),
          "bounded.xlsx",
        );
      expect(response.status).toBe(400);
      expect(bodyAt(response, "error", "message")).toContain("attachment");
    }
  });
  it("rejects compressed entries, CRC mismatches and malformed XML without formula execution", async () => {
    const xml =
      '<worksheet><row><c t="inlineStr"><is><t>A</t></is></c></row></worksheet>';
    const corrupt = storedSheet(xml);
    corrupt[corrupt.length - 1] = 32;
    for (const bytes of [
      storedSheet(xml, 8),
      corrupt,
      storedSheet("<worksheet><row></worksheet>"),
    ]) {
      expect(
        (
          await api
            .post(`${path}/import`)
            .field("format", "xlsx")
            .attach("file", bytes, "invalid.xlsx")
        ).status,
      ).toBe(400);
    }
  });
  it("rejects missing file/format, invalid snapshot JSON, scalar type violations and repeated formats", async () => {
    expect(
      (await api.post(`${path}/import`).field("format", "csv")).status,
    ).toBe(400);
    expect(
      (
        await api
          .post(`${path}/import`)
          .attach("file", Buffer.from("A\n1"), "a.csv")
      ).status,
    ).toBe(400);
    expect(
      (
        await api
          .post(`${path}/export`)
          .field("format", "csv")
          .attach("file", Buffer.from("invalid"), "a.json")
      ).status,
    ).toBe(400);
    expect(
      (
        await exportRequest("csv", {
          result: { ...result, rows: [[]] },
          context,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api
          .post(`${path}/import`)
          .field("format", "csv")
          .field("format", "xlsx")
          .attach("file", Buffer.from("A\n1"), "a.csv")
      ).status,
    ).toBe(400);
  });
});
it("keeps Excel's pre/post fictitious leap-day conversion and parser column IDs", () => {
  const snapshot = {
    ...result,
    rows: [{ date: "1900-01-01" }, { date: "1900-03-01" }],
  };
  expect(
    importAnalysisWorkbook(
      analysisResultWorkbook(snapshot, context),
      parseAnalysisWorkbookXml,
    ).rows.map((row) => row.date),
  ).toEqual(["1900-01-01", "1900-03-01"]);
});
