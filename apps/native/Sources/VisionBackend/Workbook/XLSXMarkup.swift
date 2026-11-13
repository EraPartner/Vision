import Foundation

/// The XML event parser of `packages/shared-utils/src/xlsx/xml.ts` (itself a port of saxen's
/// non-namespace mode): names lose a `prefix:`, attribute values and text have the five XML
/// entities and numeric character references decoded, comments, processing instructions,
/// declarations and CDATA are skipped, text outside the root is ignored, a malformed attribute
/// is skipped and a structural error throws. Text is UTF-16 code units throughout, as in
/// JavaScript, so a reference to half a surrogate pair stays what it is.
enum XLSXMarkup {
    typealias Units = [UInt16]

    struct Failure: Error, Equatable, Sendable {
        let message: String
    }

    /// An element's attributes in the order the TypeScript object holds them.
    struct Attributes {
        private(set) var names: [Units] = []
        private var values: [Units: Units] = [:]

        subscript(_ name: String) -> Units? { values[Array(name.utf16)] }
        subscript(units name: Units) -> Units? {
            get { values[name] }
            set {
                if values[name] == nil { names.append(name) }
                values[name] = newValue
            }
        }

        func text(_ name: String) -> String? { self[name].map { String(decoding: $0, as: UTF16.self) } }
        /// A JavaScript truthiness test: present and not empty.
        func filled(_ name: String) -> Units? { self[name].flatMap { $0.isEmpty ? nil : $0 } }
    }

    struct Handlers {
        var open: (Units, Attributes) throws -> Void = { _, _ in }
        var close: (Units) throws -> Void = { _ in }
        var text: (Units) throws -> Void = { _ in }
    }

    static func units(_ text: String) -> Units { Array(text.utf16) }

    private static let entities: [Units: Units] = [
        units("amp"): units("&"), units("apos"): units("'"), units("gt"): units(">"), units("lt"): units("<"),
        units("quot"): units("\""), units("AMP"): units("&"), units("APOS"): units("'"), units("GT"): units(">"),
        units("LT"): units("<"), units("QUOT"): units("\""),
    ]

    private static func isDigit(_ unit: UInt16) -> Bool { unit >= 48 && unit <= 57 }
    private static func isHex(_ unit: UInt16) -> Bool {
        isDigit(unit) || (unit >= 97 && unit <= 102) || (unit >= 65 && unit <= 70)
    }
    private static func isWord(_ unit: UInt16) -> Bool {
        isDigit(unit) || (unit >= 97 && unit <= 122) || (unit >= 65 && unit <= 90) || unit == 95
    }

    /// `String.fromCharCode(number)`: the number modulo 65536.
    private static func charCode(_ number: Double) -> UInt16 {
        guard number.isFinite else { return 0 }
        return UInt16(fmod(number.rounded(.towardZero), 65536))
    }

    /// `parseInt(digits, 16)` for a run of hexadecimal digits, rounded like a double.
    private static func hexNumber(_ digits: ArraySlice<UInt16>) -> Double {
        let significant = Array(digits.drop { $0 == 48 })
        var head: UInt64 = 0
        for unit in significant.prefix(16) {
            head = head << 4 | UInt64(Int(String(UnicodeScalar(UInt8(unit))), radix: 16) ?? 0)
        }
        let rest = significant.dropFirst(16)
        if rest.contains(where: { $0 != 48 }) { head |= 1 }
        return Double(head) * pow(16, Double(rest.count))
    }

    /// `decodeEntities(text)`: `/&#(\d+);|&#x([0-9a-f]+);|&(\w+);/gi` replaced.
    static func decodeEntities(_ text: Units) -> Units {
        guard text.count > 3, text.contains(38) else { return text }
        var out: Units = []
        out.reserveCapacity(text.count)
        var index = 0
        func run(from start: Int, _ accepts: (UInt16) -> Bool) -> Int? {
            var end = start
            while end < text.count, accepts(text[end]) { end += 1 }
            return end > start && end < text.count && text[end] == 59 ? end : nil
        }
        while index < text.count {
            guard text[index] == 38 else {
                out.append(text[index])
                index += 1
                continue
            }
            let next = index + 1 < text.count ? text[index + 1] : 0
            if next == 35, let end = run(from: index + 2, isDigit) {
                let digits = String(decoding: text[(index + 2)..<end], as: UTF16.self)
                out.append(charCode(Double(digits) ?? .infinity))
                index = end + 1
            } else if next == 35, index + 2 < text.count, text[index + 2] == 120 || text[index + 2] == 88,
                let end = run(from: index + 3, isHex)
            {
                out.append(charCode(hexNumber(text[(index + 3)..<end])))
                index = end + 1
            } else if let end = run(from: index + 1, isWord) {
                let name = Array(text[(index + 1)..<end])
                out.append(contentsOf: entities[name] ?? Array(text[index...end]))
                index = end + 1
            } else {
                out.append(38)
                index += 1
            }
        }
        return out
    }

    /// Drops a `prefix:`; an attribute keeps an `xmlns:` declaration as it is.
    static func trimPrefix(_ name: Units, attribute: Bool = false) -> Units {
        for (index, unit) in name.enumerated() where unit == 58 {
            if !(attribute && index == 5 && name.starts(with: units("xmlns"))) { return Array(name[(index + 1)...]) }
        }
        return name
    }

    private static func isSpace(_ code: Int) -> Bool { code == 32 || (code < 14 && code > 8) }

    private static func isNameCharacter(_ code: Int) -> Bool {
        (code > 96 && code < 123) || (code > 64 && code < 91) || (code > 47 && code < 59) || code == 45 || code == 95
            || code == 46
    }

    private static func index(of needle: UInt16, in text: Units, from start: Int) -> Int {
        var position = max(0, start)
        while position < text.count {
            if text[position] == needle { return position }
            position += 1
        }
        return -1
    }

    private static func index(of needle: Units, in text: Units, from start: Int) -> Int {
        var position = max(0, start)
        while position + needle.count <= text.count {
            if text[position..<(position + needle.count)].elementsEqual(needle) { return position }
            position += 1
        }
        return -1
    }

    /// saxen's attribute scanner without namespace handling. `-1` stands for the `NaN` a
    /// JavaScript `charCodeAt` past the end answers; no test below takes it for a character.
    private static func parseAttributes(_ s: Units, _ start: Int) -> Attributes {
        var attributes = Attributes()
        var seen: Set<Units> = []
        let l = s.count
        func at(_ index: Int) -> Int { index >= 0 && index < l ? Int(s[index]) : -1 }
        func slice(_ from: Int, _ to: Int) -> Units {
            let low = min(max(from, 0), l)
            let high = min(max(to, 0), l)
            return low <= high ? Array(s[low..<high]) : Array(s[high..<low])
        }
        var i = start
        parseAttribute: while i < l {
            defer { i += 1 }
            var skip = false
            var w = at(i)
            if isSpace(w) { continue }
            if (w < 65 || w > 122 || (w > 90 && w < 97)) && w != 95 && w != 58 { skip = true }
            var j = i + 1
            while j < l {
                w = at(j)
                if isNameCharacter(w) {
                    j += 1
                    continue
                }
                if isSpace(w) {
                    // An attribute without a value.
                    i = j
                    continue parseAttribute
                }
                if w == 61 { break }
                skip = true
                j += 1
            }
            let name = slice(i, j)
            if name == units("xmlns:xmlns") { skip = true }
            var value: Units = []
            w = at(j + 1)
            if w == 34 {
                i = j + 2
                j = index(of: 34, in: s, from: i)
                if j == -1 {
                    j = index(of: 39, in: s, from: i)
                    if j != -1 { skip = true }
                }
            } else if w == 39 {
                i = j + 2
                j = index(of: 39, in: s, from: i)
                if j == -1 {
                    j = index(of: 34, in: s, from: i)
                    if j != -1 { skip = true }
                }
            } else {
                skip = true
                j += 1
                while j < l {
                    if isSpace(at(j + 1)) { break }
                    j += 1
                }
            }
            if j == -1 {
                j = l
                skip = true
            }
            if !skip { value = slice(i, j) }
            i = j
            while j + 1 < l {
                if isSpace(at(j + 1)) { break }
                if i == j { skip = true }
                j += 1
            }
            i = j + 1
            if skip || seen.contains(name) { continue }
            seen.insert(name)
            // Assigning `__proto__` on a JavaScript object adds no property.
            if name != units("__proto__") { attributes[units: name] = value }
        }
        return attributes
    }

    /// `parseXml(xml, handlers)`: the handlers called in document order.
    static func parse(_ xml: Units, _ handlers: Handlers) throws {
        var stack: [Units] = []
        var rootFound = false
        var j = 0
        let count = xml.count
        func at(_ index: Int) -> Int { index >= 0 && index < count ? Int(xml[index]) : -1 }
        func fail(_ message: String) -> Failure { Failure(message: "Invalid XML: \(message)") }
        while j != -1 {
            let i = at(j) == 60 ? j : index(of: 60, in: xml, from: j)
            if i == -1 {
                if !stack.isEmpty { throw fail("unexpected end of file") }
                if !rootFound { throw fail("missing start tag") }
                return
            }
            rootFound = true
            if j != i, !stack.isEmpty { try handlers.text(decodeEntities(Array(xml[min(j, i)..<i]))) }
            var w = at(i + 1)
            if w == 33 {
                let q = at(i + 2)
                if q == 91, i + 9 <= count, xml[(i + 3)..<(i + 9)].elementsEqual(units("CDATA[")) {
                    j = index(of: units("]]>"), in: xml, from: i)
                    if j == -1 { throw fail("unclosed cdata") }
                    j += 3
                    continue
                }
                if q == 45, at(i + 3) == 45 {
                    j = index(of: units("-->"), in: xml, from: i)
                    if j == -1 { throw fail("unclosed comment") }
                    j += 3
                    continue
                }
            }
            if w == 63 {
                j = index(of: units("?>"), in: xml, from: i)
                if j == -1 { throw fail("unclosed question") }
                j += 2
                continue
            }
            var x = i + 1
            while true {
                let v = at(x)
                if v == -1 { throw fail("unclosed tag") }
                if v == 34 {
                    let q = index(of: 34, in: xml, from: x + 1)
                    x = q != -1 ? q : x
                } else if v == 39 {
                    let q = index(of: 39, in: xml, from: x + 1)
                    x = q != -1 ? q : x
                } else if v == 62 {
                    j = x
                    break
                }
                x += 1
            }
            if w == 33 {
                j += 1
                continue
            }
            if w == 47 {
                guard let name = stack.popLast() else { throw fail("missing open tag") }
                let end = i + 2 + name.count
                guard end <= count, xml[(i + 2)..<end].elementsEqual(name) else { throw fail("closing tag mismatch") }
                var q = end
                while q < j {
                    if !isSpace(at(q)) { throw fail("close tag") }
                    q += 1
                }
                try handlers.close(trimPrefix(name))
                j += 1
                continue
            }
            let selfClosing = at(j - 1) == 47
            let tag = Array(xml[(i + 1)..<max(i + 1, selfClosing ? j - 1 : j)])
            var name = tag
            var attributeStart = tag.count
            if !((w > 96 && w < 123) || (w > 64 && w < 91) || w == 95 || w == 58) {
                throw fail("illegal first char nodeName")
            }
            var q = 1
            while q < tag.count {
                w = Int(tag[q])
                if isNameCharacter(w) {
                    q += 1
                    continue
                }
                if isSpace(w) {
                    name = Array(tag[..<q])
                    attributeStart = q
                    break
                }
                throw fail("invalid nodeName")
            }
            if !selfClosing { stack.append(name) }
            var attributes = parseAttributes(tag, attributeStart)
            // The TypeScript loop writes while it reads: a prefixed name overwrites the bare
            // one, and the prefixed key keeps its raw value.
            for key in attributes.names {
                let trimmed = trimPrefix(key, attribute: true)
                if trimmed != units("__proto__") { attributes[units: trimmed] = decodeEntities(attributes[units: key] ?? []) }
            }
            try handlers.open(trimPrefix(name), attributes)
            if selfClosing { try handlers.close(trimPrefix(name)) }
            j += 1
        }
    }
}
