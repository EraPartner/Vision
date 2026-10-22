/**
 * Read the XML parts of an XLSX (ZIP) archive (ADR-245).
 *
 * Uses the central directory, stored or deflated entries only, and the
 * platform `DecompressionStream("deflate-raw")`, which browsers, Node and Bun
 * all provide. Like read-excel-file, only `*.xml` and `*.xml.rels` parts are
 * kept; a later entry with the same name replaces an earlier one. Size
 * limits are the caller's job (the backend checks them before reading).
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const body = new Response(data.slice()).body;
    if (body === null) return new Uint8Array(0);
    const inflated = body.pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
}

export async function readZipXmlParts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset: number) => view.getUint16(offset, true);
    const u32 = (offset: number) => view.getUint32(offset, true);
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
        if (u32(offset) === END_OF_CENTRAL_DIRECTORY) {
            end = offset;
            break;
        }
    }
    if (end < 0) throw new Error("Invalid ZIP archive: no end of central directory");
    const count = u16(end + 10);
    let offset = u32(end + 16);
    const decoder = new TextDecoder("utf-8");
    const parts = new Map<string, Uint8Array>();
    for (let index = 0; index < count; index++) {
        if (offset + 46 > bytes.length || u32(offset) !== CENTRAL_HEADER) {
            throw new Error("Invalid ZIP archive: bad central directory");
        }
        const flags = u16(offset + 8);
        const method = u16(offset + 10);
        const compressedSize = u32(offset + 20);
        const nameLength = u16(offset + 28);
        const localOffset = u32(offset + 42);
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + u16(offset + 30) + u16(offset + 32);
        if (!name.endsWith(".xml") && !name.endsWith(".xml.rels")) continue;
        if ((flags & 1) !== 0) throw new Error("Invalid ZIP archive: encrypted entry");
        if (localOffset + 30 > bytes.length || u32(localOffset) !== LOCAL_HEADER) {
            throw new Error("Invalid ZIP archive: bad local header");
        }
        const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
        if (dataStart + compressedSize > bytes.length) {
            throw new Error("Invalid ZIP archive: entry out of bounds");
        }
        const data = bytes.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) parts.set(name, data);
        else if (method === 8) parts.set(name, await inflateRaw(data));
        else throw new Error(`Invalid ZIP archive: unsupported method ${method}`);
    }
    return parts;
}
