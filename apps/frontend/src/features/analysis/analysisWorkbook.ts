import type { AnalysisResult, AnalysisValue } from "@/lib/api/analysis";
export interface AnalysisWorkbookContext {
    name: string;
    timezone: string;
    workspace: string;
    definitionId?: string;
    definitionVersion?: number;
    datasetIds?: string[];
    sourceReferences?: string[];
    assumptions?: unknown;
    formulas?: unknown;
}
const encoder = new TextEncoder();
const xml = (value: unknown) =>
    String(value ?? "")
        .split("")
        .filter(
            (char) =>
                char.charCodeAt(0) >= 32 ||
                [9, 10, 13].includes(char.charCodeAt(0)),
        )
        .join("")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
};
function zip(files: Array<[string, string]>) {
    const local: Uint8Array[] = [],
        central: Uint8Array[] = [];
    let offset = 0;
    for (const [path, text] of files) {
        const name = encoder.encode(path),
            data = encoder.encode(text),
            crc = crc32(data);
        const h = new Uint8Array(30 + name.length),
            v = new DataView(h.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 0x800, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, data.length, true);
        v.setUint32(22, data.length, true);
        v.setUint16(26, name.length, true);
        h.set(name, 30);
        local.push(h, data);
        const c = new Uint8Array(46 + name.length),
            cv = new DataView(c.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x800, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        c.set(name, 46);
        central.push(c);
        offset += h.length + data.length;
    }
    const directory = concat(central),
        end = new Uint8Array(22),
        ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, directory.length, true);
    ev.setUint32(16, offset, true);
    return concat([...local, directory, end]);
}
const columnName = (index: number) => {
    let name = "",
        n = index + 1;
    while (n) {
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
};
function cell(value: unknown, reference: string, type?: string) {
    if (value === null || value === undefined) return `<c r="${reference}"/>`;
    if (type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        const date = Date.parse(`${value}T00:00:00Z`);
        if (
            Number.isFinite(date) &&
            new Date(date).toISOString().slice(0, 10) === value
        ) {
            const days = (date - Date.UTC(1899, 11, 30)) / 86400000;
            const serial = days < 61 ? days - 1 : days;
            return `<c r="${reference}" s="1"><v>${serial}</v></c>`;
        }
    }
    if (typeof value === "boolean")
        return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const text = String(value),
        digits = text.replace(/[-+.eE]/g, "").replace(/^0+/, "");
    if (
        (typeof value === "number" ||
            /decimal|number|integer|numeric|float|double/.test(type ?? "")) &&
        /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) &&
        digits.length <= 15 &&
        Number.isFinite(Number(text))
    )
        return `<c r="${reference}"><v>${text}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(typeof value === "object" ? JSON.stringify(value) : text)}</t></is></c>`;
}
function sheet(rows: unknown[][], types: string[] = []) {
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => cell(v, `${columnName(j)}${i + 1}`, i ? types[j] : undefined)).join("")}</row>`).join("")}</sheetData></worksheet>`;
}
export function analysisResultWorkbook(
    result: AnalysisResult,
    context: AnalysisWorkbookContext,
): Uint8Array {
    if (result.rows.length > 100000)
        throw new Error("Workbook exceeds 100,000 rows");
    const columns = result.declaredColumns?.length
        ? result.declaredColumns
        : result.columns;
    const names = [
        "Results",
        "Assumptions",
        "Provenance",
        "Formula definitions",
        "Summary results",
    ];
    const rows = [
        columns.map((c) => ("label" in c ? c.label : c.id)),
        ...result.rows.map((row) => columns.map((c) => row[c.id])),
    ];
    const provenance = Object.entries({
        ...context,
        assumptions: undefined,
        formulas: undefined,
        requestId: result.requestId,
        completedAt: result.completedAt,
        window: result.window,
        complete: result.complete,
        financialCoverage: result.coverage,
        transformationCoverage: result.transformationCoverage,
        preparationLineage: result.preparationLineage,
        transformationErrors: result.transformationErrors,
        formulaErrors: result.formulaErrors,
        columns,
        precision:
            "Numeric values exceeding 15 significant digits are text. Dates use Excel 1900 calendar. Formulas are definitions only and never execute.",
        refresh: "Static snapshot. Refresh in Vision and export again.",
    })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]);
    const assumptionModel = context.assumptions as
        | {
              definitions?: Array<{
                  id: string;
                  label?: string;
                  defaultValue?: unknown;
              }>;
              values?: Record<string, unknown>;
          }
        | undefined;
    const assumptionRows: unknown[][] = [["Identifier", "Label", "Value"]];
    if (Array.isArray(assumptionModel?.definitions))
        for (const definition of assumptionModel.definitions)
            assumptionRows.push([
                definition.id,
                definition.label ?? definition.id,
                assumptionModel.values?.[definition.id] ??
                    definition.defaultValue ??
                    null,
            ]);
    else if (context.assumptions && typeof context.assumptions === "object")
        for (const [id, value] of Object.entries(context.assumptions))
            assumptionRows.push([id, id, value]);
    const formulaRows: unknown[][] = [
        ["Identifier", "Label", "Scope", "Expression (text only)", "Unit"],
    ];
    if (Array.isArray(context.formulas))
        for (const definition of context.formulas) {
            const f = definition as Record<string, unknown>;
            formulaRows.push([
                f.id,
                f.label,
                f.scope,
                f.expression,
                f.unit ? JSON.stringify(f.unit) : "",
            ]);
        }
    const sheets = [
        sheet(
            rows,
            columns.map((c) => c.type),
        ),
        sheet(assumptionRows, ["string", "string", "decimal"]),
        sheet([["Property", "Value"], ...provenance]),
        sheet(formulaRows),
        sheet(
            [
                ["Identifier", "Value"],
                ...Object.entries(result.formulaSummaries ?? {}),
            ],
            ["string", "decimal"],
        ),
    ];
    const files: Array<[string, string]> = [
        [
            "[Content_Types].xml",
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
        ],
        [
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        ],
        [
            "xl/workbook.xml",
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
        ],
        [
            "xl/_rels/workbook.xml.rels",
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        ],
        [
            "xl/styles.xml",
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
        ],
        ...sheets.map((s, i): [string, string] => [
            `xl/worksheets/sheet${i + 1}.xml`,
            s,
        ]),
    ];
    return zip(files);
}
export interface ImportedAnalysisWorkbook {
    columns: string[];
    rows: Array<Record<string, AnalysisValue>>;
    formulaCells: number;
}
/** Bounded value-only import of the Results sheet in Vision-generated stored ZIP workbooks. */
export function importAnalysisWorkbook(
    bytes: Uint8Array,
): ImportedAnalysisWorkbook {
    if (bytes.length > 10000000) throw new Error("Workbook exceeds 10 MB");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0,
        source = "",
        provenance = "";
    while (
        offset + 30 <= bytes.length &&
        view.getUint32(offset, true) === 0x04034b50
    ) {
        const method = view.getUint16(offset + 8, true),
            size = view.getUint32(offset + 18, true),
            n = view.getUint16(offset + 26, true),
            extra = view.getUint16(offset + 28, true);
        const start = offset + 30 + n + extra;
        if (start + size > bytes.length) throw new Error("Invalid ZIP entry");
        const path = new TextDecoder().decode(
            bytes.slice(offset + 30, offset + 30 + n),
        );
        if (
            path === "xl/worksheets/sheet1.xml" ||
            path === "xl/worksheets/sheet3.xml"
        ) {
            if (method !== 0)
                throw new Error(
                    "Import supports Vision-generated uncompressed XLSX only",
                );
            const data = bytes.slice(start, start + size);
            if (crc32(data) !== view.getUint32(offset + 14, true))
                throw new Error("Workbook checksum mismatch");
            if (path === "xl/worksheets/sheet1.xml")
                source = new TextDecoder().decode(data);
            else provenance = new TextDecoder().decode(data);
        }
        offset = start + size;
    }
    if (!source)
        throw new Error("Results sheet missing or workbook format unsupported");
    const doc = new DOMParser().parseFromString(source, "application/xml");
    if (doc.querySelector("parsererror"))
        throw new Error("Invalid worksheet XML");
    let formulaCells = 0;
    const rows = Array.from(doc.getElementsByTagName("row")).map((row) =>
        Array.from(row.getElementsByTagName("c")).map((c) => {
            if (c.getElementsByTagName("f").length) {
                formulaCells++;
                return null;
            }
            const type = c.getAttribute("t"),
                value = c.getElementsByTagName("v")[0]?.textContent ?? "";
            if (type === "inlineStr")
                return c.getElementsByTagName("t")[0]?.textContent ?? "";
            if (type === "b") return value === "1";
            if (!value) return null;
            if (c.getAttribute("s") === "1")
                return new Date(
                    Date.UTC(1899, 11, 30) +
                        (Number(value) < 60
                            ? Number(value) + 1
                            : Number(value)) *
                            86400000,
                )
                    .toISOString()
                    .slice(0, 10);
            return Number(value);
        }),
    );
    if (rows.length > 10001) throw new Error("Import exceeds 10,000 rows");
    let columns = (rows.shift() ?? []).map(String);
    if (provenance) {
        const metadata = new DOMParser().parseFromString(
            provenance,
            "application/xml",
        );
        const declaration = Array.from(metadata.getElementsByTagName("row"))
            .find(
                (row) =>
                    row.getElementsByTagName("t")[0]?.textContent === "columns",
            )
            ?.getElementsByTagName("t")[1]?.textContent;
        if (declaration) {
            const declared = JSON.parse(declaration) as Array<{ id: string }>;
            if (
                !Array.isArray(declared) ||
                declared.length !== columns.length ||
                declared.some((c) => typeof c.id !== "string")
            )
                throw new Error("Invalid workbook column provenance");
            columns = declared.map((c) => c.id);
        }
    }
    if (
        !columns.length ||
        columns.length > 128 ||
        new Set(columns).size !== columns.length
    )
        throw new Error("Invalid or duplicate workbook columns");
    return {
        columns,
        rows: rows.map((r) =>
            Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])),
        ),
        formulaCells,
    };
}
