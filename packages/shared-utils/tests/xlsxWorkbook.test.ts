import { describe, expect, it } from "vitest";
import { isDateFormatTemplate, readXlsxWorkbook } from "../src/xlsx/workbook.ts";
import { decodeEntities } from "../src/xlsx/xml.ts";
import { buildTestWorkbook } from "./helpers/xlsxFixture.ts";

// Expected grids are read-excel-file 9.3.12's output for the same workbook,
// recorded before the package was removed (ADR-245).
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const parseNumber = (raw: string) => ({ raw });
const NBSP = " ";

describe("readXlsxWorkbook", () => {
    it("keeps raw numbers, dates, booleans and untrimmed text with trim: false", async () => {
        const sheets = await readXlsxWorkbook(buildTestWorkbook(), { trim: false, parseNumber });
        expect(json(sheets)).toEqual([
            {
                sheet: "Transacties & kosten",
                data: [
                    [` Bk${NBSP}Record${NBSP}Id `, "Rich text", "Kanji", "été & &nbsp;", "   ", null],
                    [
                        { raw: "0012345678901234567890" },
                        { raw: "-1234.5000" },
                        "2025-01-10T00:00:00.000Z",
                        "2025-01-10T12:00:00.000Z",
                        "1899-12-31T00:00:00.000Z",
                        null,
                    ],
                    [null, null, null, null, null, null],
                    [null, true, false, null, null, " formula "],
                    [" inline ", "2025-01-10T12:00:00.000Z", null, null, null, null],
                ],
            },
            { sheet: "Leeg", data: [] },
        ]);
    });

    it("trims strings and drops blank ones by default", async () => {
        const [first] = await readXlsxWorkbook(buildTestWorkbook(), { parseNumber });
        expect(json(first?.data[0])).toEqual([`Bk${NBSP}Record${NBSP}Id`, "Rich text", "Kanji", "été & &nbsp;", null, null]);
        expect(first?.data[4]?.[0]).toBe("inline");
        expect(first?.data[1]?.[2]).toBeInstanceOf(Date);
    });

    it("rejects archives that are not workbooks", async () => {
        await expect(readXlsxWorkbook(new Uint8Array([1, 2, 3]), { parseNumber })).rejects.toThrow();
    });
});

describe("xlsx helpers", () => {
    it("detects date formats like read-excel-file", () => {
        expect(isDateFormatTemplate("dd/mm/yyyy;@")).toBe(true);
        expect(isDateFormatTemplate("[$-409]mmm-yy")).toBe(true);
        expect(isDateFormatTemplate("h:mm:ss")).toBe(true);
        expect(isDateFormatTemplate('#,##0.00 "EUR"')).toBe(false);
        expect(isDateFormatTemplate("0.00%")).toBe(false);
    });

    it("decodes the XML entities saxen decoded and keeps unknown ones", () => {
        expect(decodeEntities("&amp;&LT;&#65;&#x42;&nbsp;&Amp;")).toBe("&<AB&nbsp;&Amp;");
    });
});
