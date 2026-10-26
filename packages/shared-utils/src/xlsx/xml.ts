/**
 * Minimal XML event parser for spreadsheet parts (ADR-245).
 *
 * A port of the non-namespace mode of saxen 11 as read-excel-file 9.3.12
 * drives it, so workbooks parse exactly as they did with that package:
 * element and attribute names lose any `prefix:`; attribute values and text
 * have the five XML entities and numeric character references decoded
 * (`String.fromCharCode` semantics); comments, processing instructions,
 * `<!...>` declarations and CDATA sections are skipped; text outside the root
 * element is ignored; malformed attributes are skipped like saxen's warnings;
 * structural errors throw.
 *
 * saxen: Copyright (c) 2017-present Nico Rehwaldt and contributors, MIT.
 */

const ENTITY_PATTERN = /&#(\d+);|&#x([0-9a-f]+);|&(\w+);/gi;
const ENTITIES: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    AMP: "&",
    APOS: "'",
    GT: ">",
    LT: "<",
    QUOT: '"',
};

function replaceEntity(
    match: string,
    decimal: string | undefined,
    hex: string | undefined,
    name: string | undefined,
): string {
    if (name !== undefined) {
        return Object.prototype.hasOwnProperty.call(ENTITIES, name)
            ? (ENTITIES[name] ?? match)
            : `&${name};`;
    }
    if (decimal !== undefined) return String.fromCharCode(Number(decimal));
    return String.fromCharCode(parseInt(hex ?? "", 16));
}

export function decodeEntities(text: string): string {
    if (text.length > 3 && text.includes("&")) {
        return text.replace(ENTITY_PATTERN, replaceEntity);
    }
    return text;
}

/** Drop a `prefix:`; attribute names keep `xmlns:` declarations as they are. */
function trimPrefix(name: string, isAttribute = false): string {
    for (let i = 0; i < name.length; i++) {
        if (name[i] === ":") {
            if (!(isAttribute && i === 5 && name.startsWith("xmlns"))) {
                return name.slice(i + 1);
            }
        }
    }
    return name;
}

export interface XmlHandlers {
    onOpenTag?: (name: string, attributes: Record<string, string>) => void;
    onCloseTag?: (name: string) => void;
    onText?: (text: string) => void;
}

function isSpace(code: number): boolean {
    return code === 32 || (code < 14 && code > 8);
}

function isNameChar(code: number): boolean {
    return (
        (code > 96 && code < 123) ||
        (code > 64 && code < 91) ||
        (code > 47 && code < 59) ||
        code === 45 ||
        code === 95 ||
        code === 46
    );
}

/** saxen's attribute scanner without namespace handling. */
function parseAttributes(s: string, start: number): Record<string, string> {
    const attrs: Record<string, string> = {};
    const seen = new Set<string>();
    const l = s.length;
    let i = start;
    let j: number;
    let w: number;
    parseAttr: for (; i < l; i++) {
        let skip = false;
        w = s.charCodeAt(i);
        if (isSpace(w)) continue;
        if ((w < 65 || w > 122 || (w > 90 && w < 97)) && w !== 95 && w !== 58) {
            skip = true;
        }
        for (j = i + 1; j < l; j++) {
            w = s.charCodeAt(j);
            if (isNameChar(w)) continue;
            if (isSpace(w)) {
                // Attribute without a value.
                i = j;
                continue parseAttr;
            }
            if (w === 61) break;
            skip = true;
        }
        const name = s.substring(i, j);
        if (name === "xmlns:xmlns") skip = true;
        let value = "";
        w = s.charCodeAt(j + 1);
        if (w === 34) {
            j = s.indexOf('"', (i = j + 2));
            if (j === -1) {
                j = s.indexOf("'", i);
                if (j !== -1) skip = true;
            }
        } else if (w === 39) {
            j = s.indexOf("'", (i = j + 2));
            if (j === -1) {
                j = s.indexOf('"', i);
                if (j !== -1) skip = true;
            }
        } else {
            skip = true;
            for (j = j + 1; j < l; j++) {
                if (isSpace(s.charCodeAt(j + 1))) break;
            }
        }
        if (j === -1) {
            j = l;
            skip = true;
        }
        if (!skip) value = s.substring(i, j);
        i = j;
        for (; j + 1 < l; j++) {
            if (isSpace(s.charCodeAt(j + 1))) break;
            if (i === j) skip = true;
        }
        i = j + 1;
        if (skip) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        attrs[name] = value;
    }
    return attrs;
}

/** Parse a whole document, calling the handlers in document order. */
export function parseXml(xml: string, handlers: XmlHandlers): void {
    const stack: string[] = [];
    let rootFound = false;
    let i: number;
    let j = 0;
    const fail = (message: string): never => {
        throw new Error(`Invalid XML: ${message}`);
    };
    while (j !== -1) {
        i = xml.charCodeAt(j) === 60 ? j : xml.indexOf("<", j);
        if (i === -1) {
            if (stack.length > 0) fail("unexpected end of file");
            if (!rootFound) fail("missing start tag");
            return;
        }
        rootFound = true;
        if (j !== i && stack.length > 0 && handlers.onText) {
            handlers.onText(decodeEntities(xml.substring(j, i)));
        }
        let w = xml.charCodeAt(i + 1);
        if (w === 33) {
            const q = xml.charCodeAt(i + 2);
            if (q === 91 && xml.substring(i + 3, i + 9) === "CDATA[") {
                j = xml.indexOf("]]>", i);
                if (j === -1) fail("unclosed cdata");
                j += 3;
                continue;
            }
            if (q === 45 && xml.charCodeAt(i + 3) === 45) {
                j = xml.indexOf("-->", i);
                if (j === -1) fail("unclosed comment");
                j += 3;
                continue;
            }
        }
        if (w === 63) {
            j = xml.indexOf("?>", i);
            if (j === -1) fail("unclosed question");
            j += 2;
            continue;
        }
        let x = i + 1;
        for (; ; x++) {
            const v = xml.charCodeAt(x);
            if (Number.isNaN(v)) fail("unclosed tag");
            if (v === 34) {
                const q = xml.indexOf('"', x + 1);
                x = q !== -1 ? q : x;
            } else if (v === 39) {
                const q = xml.indexOf("'", x + 1);
                x = q !== -1 ? q : x;
            } else if (v === 62) {
                j = x;
                break;
            }
        }
        if (w === 33) {
            j += 1;
            continue;
        }
        if (w === 47) {
            const name = stack.pop();
            if (name === undefined) fail("missing open tag");
            const end = i + 2 + (name as string).length;
            if (xml.substring(i + 2, end) !== name) fail("closing tag mismatch");
            for (let q = end; q < j; q++) {
                if (!isSpace(xml.charCodeAt(q))) fail("close tag");
            }
            handlers.onCloseTag?.(trimPrefix(name as string));
            j += 1;
            continue;
        }
        const selfClosing = xml.charCodeAt(j - 1) === 47;
        const tag = xml.substring(i + 1, selfClosing ? j - 1 : j);
        let name = tag;
        let attrStart = tag.length;
        if (!((w > 96 && w < 123) || (w > 64 && w < 91) || w === 95 || w === 58)) {
            fail("illegal first char nodeName");
        }
        for (let q = 1; q < tag.length; q++) {
            w = tag.charCodeAt(q);
            if (isNameChar(w)) continue;
            if (isSpace(w)) {
                name = tag.substring(0, q);
                attrStart = q;
                break;
            }
            fail("invalid nodeName");
        }
        if (!selfClosing) stack.push(name);
        if (handlers.onOpenTag) {
            const attributes = parseAttributes(tag, attrStart);
            // Mutating while iterating is read-excel-file's own loop: a
            // prefixed name overwrites the bare one, and the prefixed key
            // keeps its raw value. Kept as is for identical results.
            for (const key in attributes) {
                attributes[trimPrefix(key, true)] = decodeEntities(attributes[key] as string);
            }
            handlers.onOpenTag(trimPrefix(name), attributes);
        }
        if (selfClosing) handlers.onCloseTag?.(trimPrefix(name));
        j += 1;
    }
}
