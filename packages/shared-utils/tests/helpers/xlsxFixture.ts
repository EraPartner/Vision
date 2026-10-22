/** A small hand-written XLSX covering the cell rules the reader must keep. */
import zlib from "node:zlib";

function zipParts(parts: [string, string, boolean][]): Uint8Array {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content, deflate] of parts) {
        const raw = Buffer.from(content, "utf8");
        const data = deflate ? zlib.deflateRawSync(raw) : raw;
        const nameBytes = Buffer.from(name, "utf8");
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(deflate ? 8 : 0, 8);
        header.writeUInt32LE(zlib.crc32(raw), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(raw.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(zlib.crc32(raw), 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(header, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += header.length + nameBytes.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(parts.length, 8);
    end.writeUInt16LE(parts.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

export function buildTestWorkbook(): Uint8Array {
    return zipParts([
        ["[Content_Types].xml", "<Types/>", false],
        [
            "xl/workbook.xml",
            `<?xml version="1.0"?><workbook xmlns:r="${REL}"><workbookPr date1904="0"/><sheets><sheet name="Transacties &amp; kosten" sheetId="1" r:id="rId1"/><sheet name="Leeg" sheetId="2" r:id="rId2"/></sheets></workbook>`,
            true,
        ],
        [
            "xl/_rels/workbook.xml.rels",
            `<Relationships><Relationship Id="rId1" Type="${REL}worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rS" Type="${REL}styles" Target="styles.xml"/><Relationship Id="rT" Type="${REL}sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
            false,
        ],
        [
            "xl/styles.xml",
            `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;EUR&quot;"/></numFmts><cellStyleXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf xfId="1"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
            true,
        ],
        [
            "xl/sharedStrings.xml",
            `<sst><si><t> Bk Record Id </t></si><si><r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r></si><si><t>Kanji</t><rPh sb="0" eb="1"><t>kana</t></rPh></si><si><t>&#233;t&#xE9; &amp; &nbsp;</t></si><si><t>   </t></si></sst>`,
            true,
        ],
        [
            "xl/worksheets/sheet1.xml",
            `<worksheet><dimension ref="A1:F6"/><sheetData>` +
                `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>` +
                `<row r="2"><c r="A2"><v>0012345678901234567890</v></c><c r="B2" s="2"><v>-1234.5000</v></c><c r="C2" s="1"><v>45667</v></c><c r="D2" s="3"><v>45667.5</v></c><c r="E2" s="4"><v>1</v></c></row>` +
                `<row r="4"><c r="B4" t="b"><v>1</v></c><c r="C4" t="b"><v>0</v></c><c r="D4" t="e"><v>#DIV/0!</v></c><c r="F4" t="str"><f>A1</f><v> formula </v></c></row>` +
                `<row r="5"><c r="A5" t="inlineStr"><is><t xml:space="preserve"> inline </t></is></c><c r="B5" t="d"><v>2025-01-10T12:00:00Z</v></c><c r="C5"/><c r="D5" t="s"/></row>` +
                `<row r="6"/></sheetData></worksheet>`,
            true,
        ],
        ["xl/worksheets/sheet2.xml", "<worksheet><sheetData/></worksheet>", false],
    ]);
}
