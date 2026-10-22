/**
 * XLSX workbook reader (ADR-245; replaces `read-excel-file`).
 *
 * Returns every sheet in workbook order as `{ sheet, data }`, where `data` is
 * a rectangular grid of cell values, with the same rules read-excel-file
 * 9.3.12 applied with the options Vision used (`trim`, `parseNumber`):
 *
 * - strings (shared, inline, formula `str`) are trimmed unless `trim` is
 *   false; an empty string is an empty cell (`null`)
 * - numbers reach `parseNumber` as the raw `<v>` text, so identifiers and
 *   amounts never pass through a JavaScript number
 * - numbers styled with a date format become `Date`s (1900 or 1904 epoch)
 * - booleans become `true`/`false`; error cells are empty
 * - trailing empty rows and columns are dropped, gaps are `null`
 *
 * A differential test compared this reader with read-excel-file on
 * generated and synthetic Saxo workbooks before the package was removed.
 */
import { parseXml } from "./xml.ts";
import { readZipXmlParts } from "./zip.ts";

export type XlsxCell<N> = string | boolean | Date | N | null;

export interface XlsxSheet<N> {
    sheet: string;
    data: XlsxCell<N>[][];
}

export interface ReadXlsxOptions<N> {
    /** Trim string cells (default true). */
    trim?: boolean;
    /** Map the raw numeric text of a non-date number cell. */
    parseNumber: (raw: string) => N;
}

interface NumberFormat {
    id: number;
    template?: string | undefined;
}

interface CellStyle {
    numberFormat?: NumberFormat;
    xfId?: number;
}

const RELATIONSHIP_BASES = [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/",
];

const BUILT_IN_DATE_FORMAT_IDS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51,
    52, 53, 54, 55, 56, 57, 58, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
]);

const DATE_TOKENS = new Set([
    "s", "ss", "m", "mm", "h", "hh", "am", "pm", "a", "p", "d", "dd", "ddd", "dddd", "aaa",
    "aaaa", "aaaaa", "mmm", "mmmm", "mmmmm", "y", "yy", "yyyy", "e", "ee", "eeee",
]);

/** read-excel-file's guess whether a custom number format shows a date. */
export function isDateFormatTemplate(format: string): boolean {
    const template = format
        .toLowerCase()
        .replace(/;@$/, "")
        .replace(/\\./g, " ");
    return template.split(";").some((section) => {
        const tokens = section
            .replace(/"[^"]*"/g, " ")
            .replace(/(\[?[smhd]{1,2}\]?)[.,]00?0?/g, "$1")
            .replace(/\[([smhd]{1,2})\]/g, "$1")
            .replace(/\[[^\]]*\]/g, "")
            .split(/[^a-z0#?%]+/)
            .filter((token) => token !== "");
        return tokens.length > 0 && tokens.every((token) => DATE_TOKENS.has(token));
    });
}

/** Serial day number to epoch milliseconds, exactly as read-excel-file did. */
export function excelSerialToTime(serial: number, epoch1904: boolean): number {
    const day = 24 * 60 * 60 * 1000;
    const adjusted = epoch1904 ? serial + (1904 - 1900) * 365 + 1 + 1 : serial;
    return Math.floor((adjusted - (1 + 1 + (1970 - 1900) * 365 + 17)) * day);
}

/** "B12" → [12, 2]; letters are not validated, as in read-excel-file. */
function parseCellAddress(address: string): [number, number] {
    let column = 0;
    for (let i = 0; i < address.length; i++) {
        const code = address.charCodeAt(i);
        if (code >= 48 && code <= 57) {
            const row = Number(address.slice(i));
            if (Number.isNaN(row)) break;
            return [row, column];
        }
        column = column * 26 + code - 64;
    }
    throw new Error(`<c r="${address}">`);
}

function relationTarget(target: string): string {
    return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

function parseRelationships(xml: string) {
    const sheets = new Map<string, string>();
    let sharedStrings: string | undefined;
    let styles: string | undefined;
    parseXml(xml, {
        onOpenTag(name, attributes) {
            if (name !== "Relationship") return;
            const base = RELATIONSHIP_BASES.find((prefix) => attributes.Type?.startsWith(prefix));
            const kind = base === undefined ? undefined : attributes.Type?.slice(base.length);
            const target = attributes.Target;
            if (kind === "styles") styles = relationTarget(target as string);
            else if (kind === "sharedStrings") sharedStrings = relationTarget(target as string);
            else if (kind === "worksheet") sheets.set(String(attributes.Id), relationTarget(target as string));
        },
    });
    return { sheets, sharedStrings, styles };
}

function parseWorkbookInfo(xml: string) {
    let epoch1904: boolean | undefined;
    const sheets: { name: string; relationId: string | undefined }[] = [];
    parseXml(xml, {
        onOpenTag(name, attributes) {
            if (name === "workbookPr") {
                epoch1904 ??= attributes.date1904 === "1";
            } else if (name === "sheet" && attributes.name) {
                sheets.push({ name: attributes.name, relationId: attributes.id });
            }
        },
    });
    return { epoch1904: epoch1904 ?? false, sheets };
}

function parseSharedStrings(xml: string): string[] {
    const strings: string[] = [];
    let item: { t: boolean; r: boolean; rPh: boolean; text: string } | undefined;
    parseXml(xml, {
        onOpenTag(name) {
            if (name === "si") item = { t: false, r: false, rPh: false, text: "" };
            else if (item && (name === "t" || name === "r" || name === "rPh")) item[name] = true;
        },
        onCloseTag(name) {
            if (name === "si") {
                strings.push(item?.text ?? "");
                item = undefined;
            } else if (item && (name === "t" || name === "r" || name === "rPh")) {
                item[name] = false;
            }
        },
        onText(text) {
            if (!item || item.rPh || !item.t) return;
            item.text = item.r ? item.text + text : text;
        },
    });
    return strings;
}

function parseStyles(xml: string): CellStyle[] {
    const numberFormats: (NumberFormat | undefined)[] = [];
    const baseStyles: CellStyle[] = [];
    const styles: CellStyle[] = [];
    let inBase = false;
    let inCell = false;
    const cellStyle = (attributes: Record<string, string>, formats?: typeof numberFormats) => {
        const style: CellStyle = {};
        if (attributes.numFmtId) {
            const id = Number(attributes.numFmtId);
            style.numberFormat = formats?.[id] ?? { id };
        }
        return style;
    };
    parseXml(xml, {
        onOpenTag(name, attributes) {
            if (name === "numFmt") {
                const id = Number(attributes.numFmtId);
                const format: NumberFormat = { id };
                if (id >= 100) format.template = attributes.formatCode;
                numberFormats[id] = format;
            } else if (name === "cellStyleXfs") inBase = true;
            else if (name === "cellXfs") inCell = true;
            else if (name === "xf") {
                if (inBase) baseStyles.push(cellStyle(attributes));
                else if (inCell) {
                    const style = cellStyle(attributes, numberFormats);
                    if (attributes.xfId) style.xfId = Number(attributes.xfId);
                    styles.push(style);
                }
            }
        },
        onCloseTag(name) {
            if (name === "cellStyleXfs") inBase = false;
            else if (name === "cellXfs") inCell = false;
        },
    });
    return styles.map((style) => {
        if (!style.xfId) return style;
        const { xfId, ...own } = style;
        return { ...baseStyles[xfId], ...own };
    });
}

type Parsed<N> =
    | { error: string }
    | { type: "s"; value: string }
    | { type: "n"; value: string }
    | { type: "d"; value: number }
    | { type: "b"; value: boolean }
    | { type: null; value: null }
    | { type: "e"; value: string }
    | { type: "x"; value: N };

const EMPTY = { type: null, value: null } as const;

interface SheetContext {
    sharedStrings: string[];
    styles: CellStyle[];
    epoch1904: boolean;
    dateCache: Map<number, boolean>;
    trim: boolean;
}

function isDateStyle(style: CellStyle, cache: Map<number, boolean>): boolean {
    const format = style.numberFormat;
    if (!format) return false;
    if (BUILT_IN_DATE_FORMAT_IDS.has(format.id)) return true;
    if (!format.template) return false;
    let cached = cache.get(format.id);
    if (cached === undefined) {
        cached = isDateFormatTemplate(format.template);
        cache.set(format.id, cached);
    }
    return cached;
}

function parseCell<N>(
    t: string | undefined,
    s: string | undefined,
    v: string | undefined,
    inline: string | undefined,
    context: SheetContext,
): Parsed<N> {
    switch (t || "n") {
        case "str":
            if (v === undefined) return { error: "VALUE_MISSING" };
            return v ? { type: "s", value: v } : EMPTY;
        case "inlineStr":
            if (inline === undefined) return { error: "VALUE_MISSING" };
            return { type: "s", value: inline };
        case "s": {
            if (!v) return { error: "VALUE_MISSING" };
            const index = Number(v);
            const value = Number.isNaN(index) ? undefined : context.sharedStrings[index];
            return value === undefined ? { error: "VALUE_INVALID" } : { type: "s", value };
        }
        case "b":
            if (!v) return { error: "VALUE_MISSING" };
            if (v === "1") return { type: "b", value: true };
            if (v === "0") return { type: "b", value: false };
            return { error: "VALUE_INVALID" };
        case "e":
            if (!v) return { error: "VALUE_MISSING" };
            return { type: "e", value: v };
        case "d": {
            if (!v) return EMPTY;
            const date = new Date(v);
            return Number.isNaN(date.valueOf())
                ? { error: "VALUE_INVALID" }
                : { type: "d", value: date.getTime() };
        }
        case "n": {
            if (!v) return EMPTY;
            if (s) {
                const styleId = Number(s);
                const style = Number.isNaN(styleId) ? undefined : context.styles[styleId];
                if (style === undefined) return { error: "FORMAT_INVALID" };
                if (isDateStyle(style, context.dateCache)) {
                    const serial = Number(v);
                    if (Number.isNaN(serial)) return { error: "VALUE_INVALID" };
                    return { type: "d", value: excelSerialToTime(serial, context.epoch1904) };
                }
            }
            return { type: "n", value: v };
        }
        default:
            return { error: "TYPE_INVALID" };
    }
}

/** Cell value after the repair and trim rules read-excel-file applied. */
function cellValue<N>(
    attributes: Record<string, string>,
    v: string | undefined,
    inline: string | undefined,
    context: SheetContext,
    parseNumber: (raw: string) => N,
): { error: string } | { value: XlsxCell<N> } {
    const t = attributes.t;
    let parsed = parseCell<N>(t, attributes.s, v, inline, context);
    if ("error" in parsed && parsed.error === "VALUE_MISSING") {
        if (["str", "inlineStr", "s", "b"].includes(t || "n")) parsed = EMPTY;
    }
    if (t === "e") parsed = EMPTY;
    if ("error" in parsed) return parsed;
    if (parsed.type === "s") {
        const text = context.trim ? parsed.value.trim() : parsed.value;
        return { value: text === "" ? null : text };
    }
    if (parsed.type === "n") return { value: parseNumber(parsed.value) };
    if (parsed.type === "d") return { value: new Date(parsed.value) };
    if (parsed.type === "e" || parsed.type === "x") return { value: parsed.value as XlsxCell<N> };
    return { value: parsed.value };
}

function parseSheet<N>(xml: string, context: SheetContext, parseNumber: (raw: string) => N) {
    type CellState = {
        attributes: Record<string, string>;
        v: boolean;
        is: boolean;
        t: boolean;
        r: boolean;
        rPh: boolean;
        vText: string | undefined;
        inline: string | undefined;
    };
    type Data = {
        rows: XlsxCell<N>[][];
        row: XlsxCell<N>[] | undefined;
        rowNumber: number | undefined;
        cell: CellState | undefined;
        cursor: [number, number];
        rowCount: number;
        columnCount: number;
        dataRowCount: number;
        dataColumnCount: number;
    };
    let data: Data | undefined;
    parseXml(xml, {
        onOpenTag(name, attributes) {
            if (name === "dimension") {
                for (const ref of (attributes.ref as string).split(":")) parseCellAddress(ref);
            } else if (name === "sheetData") {
                data = {
                    rows: [],
                    row: undefined,
                    rowNumber: undefined,
                    cell: undefined,
                    cursor: [0, 0],
                    rowCount: 0,
                    columnCount: 0,
                    dataRowCount: 0,
                    dataColumnCount: 0,
                };
            } else if (data) {
                if (name === "row") {
                    if (attributes.r) data.rowNumber = Number(attributes.r);
                    data.row = [];
                } else if (name === "c") {
                    data.cell = {
                        attributes,
                        v: false,
                        is: false,
                        t: false,
                        r: false,
                        rPh: false,
                        vText: undefined,
                        inline: undefined,
                    };
                } else if (data.cell) {
                    const cell = data.cell;
                    if (name === "v") cell.v = true;
                    else if (name === "is") {
                        cell.is = true;
                        cell.inline = "";
                    } else if (name === "t" || name === "r" || name === "rPh") cell[name] = true;
                }
            }
        },
        onCloseTag(name) {
            if (!data) return;
            if (name === "row") {
                if (data.rowNumber) {
                    const previous = data.rows.length;
                    if (data.rowNumber <= previous) {
                        throw new Error(
                            `Out-of-place <row/> number ${data.rowNumber} follows <row/> number ${previous}`,
                        );
                    }
                    while (data.rowNumber > data.rows.length + 1) data.rows.push([]);
                }
                data.rows.push(data.row as XlsxCell<N>[]);
                if ((data.row as XlsxCell<N>[]).length > 0) data.dataRowCount = data.rowNumber as number;
                if ((data.rowNumber as number) > data.rowCount) data.rowCount = data.rowNumber as number;
                data.row = undefined;
                data.rowNumber = undefined;
            } else if (name === "c") {
                const cellState = data.cell as CellState;
                const [row, column] = parseCellAddress(cellState.attributes.r as string);
                const result = cellValue(
                    cellState.attributes,
                    cellState.vText,
                    cellState.inline,
                    context,
                    parseNumber,
                );
                if (row < data.cursor[0] || (row === data.cursor[0] && column <= data.cursor[1])) {
                    throw new Error(`Out-of-place <c/> at row ${row} col ${column}`);
                }
                data.cursor = [row, column];
                if (!data.rowNumber) data.rowNumber = row;
                if ("error" in result) {
                    throw new Error(`<c/> at row ${row}, col ${column}: ${result.error}`);
                }
                if (result.value !== null) {
                    const target = data.row as XlsxCell<N>[];
                    while (column > target.length + 1) target.push(null);
                    target.push(result.value);
                    if (column > data.dataColumnCount) data.dataColumnCount = column;
                }
                if (column > data.columnCount) data.columnCount = column;
                data.cell = undefined;
            } else if (data.cell) {
                const cell = data.cell;
                if (name === "v") {
                    cell.v = false;
                    cell.vText ||= "";
                } else if (name === "is") cell.is = false;
                else if (name === "t" || name === "r" || name === "rPh") cell[name] = false;
            }
        },
        onText(text) {
            const cell = data?.cell;
            if (!cell) return;
            if (cell.v) cell.vText = text;
            else if (cell.is && !cell.rPh && cell.t) {
                cell.inline = cell.r ? (cell.inline ?? "") + text : text;
            }
        },
    });
    if (!data) throw new Error("Worksheet has no <sheetData>");
    let rows = data.rows;
    if (data.dataRowCount < data.rowCount) rows = rows.slice(0, data.dataRowCount);
    const width = data.dataColumnCount;
    return rows.map((row) => {
        const trimmed = row.length > width ? row.slice(0, width) : row;
        while (trimmed.length < width) trimmed.push(null);
        return trimmed;
    });
}

export async function readXlsxWorkbook<N>(
    bytes: Uint8Array,
    { trim = true, parseNumber }: ReadXlsxOptions<N>,
): Promise<XlsxSheet<N>[]> {
    const parts = await readZipXmlParts(bytes);
    const decoder = new TextDecoder("utf-8");
    const text = (name: string): string | undefined => {
        const part = parts.get(name);
        return part === undefined ? undefined : decoder.decode(part);
    };
    const required = (name: string): string => {
        const content = text(name);
        if (content === undefined) throw new Error(`"${name}" file not found inside the \`.xlsx\` file`);
        return content;
    };
    const relationships = parseRelationships(required("xl/_rels/workbook.xml.rels"));
    const info = parseWorkbookInfo(required("xl/workbook.xml"));
    const sharedStringsXml = text(relationships.sharedStrings ?? "xl/sharedStrings.xml");
    const stylesXml = text(relationships.styles ?? "xl/styles.xml");
    const context: SheetContext = {
        sharedStrings: sharedStringsXml === undefined ? [] : parseSharedStrings(sharedStringsXml),
        styles: stylesXml === undefined ? [] : parseStyles(stylesXml),
        epoch1904: info.epoch1904,
        dateCache: new Map(),
        trim,
    };
    if (info.sheets.length === 0) throw new Error("Workbook has no sheets");
    return info.sheets.map(({ name, relationId }) => {
        const path = relationId === undefined ? undefined : relationships.sheets.get(relationId);
        // read-excel-file returned `data: undefined` here, which every caller
        // then failed on; reject the workbook instead.
        if (path === undefined) throw new Error(`Sheet "${name}" has no worksheet part`);
        // Sheets sharing a relationship id all take the first one's name.
        const sheet = info.sheets.find((entry) => entry.relationId === relationId)?.name ?? name;
        return { sheet, data: parseSheet(required(path), context, parseNumber) };
    });
}
