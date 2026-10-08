/** Synthetic Saxo workbook construction. Contains no supplied financial data. */
import fs from "node:fs/promises";
import { ZipArchive } from "archiver";

const mainHeaders = [
  "Gebruikersnaam",
  "Transactiedatum",
  "Valutadatum",
  "Rekening-ID",
  "Transactie-ID",
  " Positie-ID",
  "Corporate action-Id",
  "Bk\u00a0Record\u00a0Id",
  "Booking\u00a0Id",
  "Transactietype",
  "Acties",
  "Boekingsbedrag",
  "Valuta",
  "Omrekeningskoers",
  "Conversion cost",
  "Totale kosten",
  "Gerealiseerde W/V",
  "IBAN",
  "IBAN owner name",
  "Opmerking",
  "Correction reason",
  "Instrument",
  "Instrumentsymbool",
  "Instrument ISIN",
  "Instrumentvaluta",
  "Type",
  "Uitwisselingsbeschrijving",
  "From Derivative",
  "Underlying asset type",
];
const tradeHeaders = [
  "Rekening-ID",
  "Transactie-ID",
  "Bk\u00a0Record\u00a0Id",
  "Booking\u00a0Id",
  "Corporate action-Id",
  "Acties",
  "Order-ID",
  "Aangepaste transactiedatum",
  "Trade execution date",
  "Trade\u00a0Event\u00a0Type",
  "Trade Type",
  "Openen/sluiten",
  "Traded\u00a0Quantity",
  "Prijs",
  "Verhandelde waarde",
  "Spreadkosten",
  "From Derivative",
  "Underlying asset type",
  "Instrument",
  "Instrumentsymbool",
  "Instrument ISIN",
  "Instrumentvaluta",
  "Type",
  "Uitwisselingsbeschrijving",
];
const bookingHeaders = [
  "Rekening-ID",
  "Transactie-ID",
  "Bk\u00a0Record\u00a0Id",
  "Booking\u00a0Id",
  "Corporate action-Id",
  "Acties",
  "Amount Type",
  "Amount\u00a0Type\u00a0Id",
  "Boekingsbedrag",
  "Conversion cost",
  "Omrekeningskoers",
  "Boekingsdatum",
  "Ex-datum",
  "Transactiedatum",
  "Eligible quantity",
  "Dividend per share",
  "Tax\u00a0Percentage",
  "Instrument",
  "Instrumentsymbool",
  "Instrument ISIN",
  "Instrumentvaluta",
];
const normalize = (header) => header.trim().replaceAll("\u00a0", " ");

export function syntheticSaxoWorkbook() {
  const shared = {
    "Rekening-ID": "ACC-1",
    Instrument: "Example Inc",
    Instrumentsymbool: "EXM:xnas",
    "Instrument ISIN": "US0000000001",
    Instrumentvaluta: "USD",
    Omrekeningskoers: 0.9,
    Transactiedatum: new Date("2025-01-10T00:00:00Z"),
    Valuta: "EUR",
  };
  const trade = {
    ...shared,
    "Transactie-ID": "TX-1",
    "Bk Record Id": 101,
    Transactietype: "Transactie",
    Acties: "Koop 10 @ 20.00 USD",
    Boekingsbedrag: -181.63,
    "Totale kosten": 2.08,
    "Conversion cost": 0.45,
  };
  const dividend = {
    ...shared,
    "Transactie-ID": "0",
    "Bk Record Id": 102,
    "Corporate action-Id": "CA-1",
    Acties: "Cashdividend",
    Transactietype: "Corporate action",
    Boekingsbedrag: 5.95,
    "Totale kosten": 0,
    Omrekeningskoers: 1,
  };
  const deposit = {
    ...shared,
    "Transactie-ID": "0",
    "Bk Record Id": 103,
    "Booking Id": "CASH-1",
    Transactietype: "Storting/Opname",
    Acties: "Storting",
    Boekingsbedrag: 500,
    Omrekeningskoers: 1,
    Instrument: "",
    Instrumentsymbool: "",
    "Instrument ISIN": "",
    Instrumentvaluta: "",
  };
  const withdrawal = {
    ...deposit,
    "Bk Record Id": 104,
    "Booking Id": "CASH-2",
    Acties: "Opname",
    Boekingsbedrag: -50,
  };
  const booking = (parent, id, kind, amount) => ({
    ...parent,
    "Booking Id": id,
    "Amount Type": kind,
    Boekingsbedrag: amount,
  });
  return [
    {
      sheet: "Transacties",
      headers: mainHeaders,
      records: [trade, dividend, deposit, withdrawal],
    },
    {
      sheet: "_Transacties",
      headers: tradeHeaders,
      records: [
        {
          ...trade,
          "Traded Quantity": 10,
          Prijs: 20,
          "Verhandelde waarde": 200,
        },
      ],
    },
    {
      sheet: "Bookings",
      headers: bookingHeaders,
      records: [
        booking(trade, "B-1", "Aandeelbedrag", -180),
        booking(trade, "B-2", "Commissie", -1),
        booking(trade, "B-3", "Beurstaks 0.35%", -0.63),
        booking(dividend, "B-4", "Corporate actions - Cash dividenden", 10),
        booking(dividend, "B-5", "Corporate actions - Bronbelasting", -1.5),
        booking(
          dividend,
          "B-6",
          "Corporate actions - Roerende voorheffing",
          -2.55,
        ),
        booking(deposit, "CASH-1", "Cashbedrag", 500),
        booking(withdrawal, "CASH-2", "Cashbedrag", -50),
      ],
    },
  ];
}

const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
function columnName(index) {
  let name = "";
  for (let number = index + 1; number; number = Math.floor((number - 1) / 26))
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  return name;
}
function cellXml(value, address) {
  if (value == null) return "";
  if (value instanceof Date)
    return `<c r="${address}" s="1"><v>${(value.getTime() - Date.UTC(1899, 11, 30)) / 86400000}</v></c>`;
  if (typeof value === "number" || value?.type === "number")
    return `<c r="${address}"><v>${value?.raw ?? value}</v></c>`;
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
}

/** Construct small valid OOXML files directly to test the parser, not Excel authoring. */
export async function writeSyntheticWorkbook(
  filePath,
  sheets = syntheticSaxoWorkbook(),
) {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const chunks = [];
  zip.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    zip.on("end", resolve);
    zip.on("error", reject);
  });
  const spreadsheetNs =
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  zip.append(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    { name: "[Content_Types].xml" },
  );
  zip.append(
    `<workbook xmlns="${spreadsheetNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escape(sheet.sheet)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
    { name: "xl/workbook.xml" },
  );
  zip.append(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    { name: "xl/_rels/workbook.xml.rels" },
  );
  zip.append(
    `<styleSheet xmlns="${spreadsheetNs}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    { name: "xl/styles.xml" },
  );
  sheets.forEach((sheet, index) => {
    const rows = [
      sheet.headers,
      ...sheet.records.map((record) =>
        sheet.headers.map((header) => record[normalize(header)] ?? ""),
      ),
    ];
    zip.append(
      `<worksheet xmlns="${spreadsheetNs}"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, colIndex) => cellXml(value, `${columnName(colIndex)}${rowIndex + 1}`)).join("")}</row>`).join("")}</sheetData></worksheet>`,
      { name: `xl/worksheets/sheet${index + 1}.xml` },
    );
  });
  await zip.finalize();
  await complete;
  const bytes = Buffer.concat(chunks);
  await fs.writeFile(filePath, bytes);
  return bytes;
}
