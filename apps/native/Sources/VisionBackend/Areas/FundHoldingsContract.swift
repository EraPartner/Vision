import Foundation

/// `fundHoldingsDocumentSchema` of `packages/types/src/fundHoldings.ts`: the holdings-document
/// contract a fund import must satisfy before it can become the basis for reported exposure.
/// The structural schema (strict objects, enums, trimmed and bounded strings, decimal weights,
/// ISO dates) and the document-level refinements (as-of, retrieval and evaluation dates,
/// unique rows and identifiers, weight totals, coverage and staleness status) with zod's
/// messages. Validation only: the route stores the document it was sent.
enum FundHoldingsContract {
    // MARK: - Leaf schemas

    /// `z.string().trim().min(min).max(max)`.
    static func trimmed(min: Int = 1, max: Int) -> Zod {
        .checked(
            .transform(.string, { value, _ in
                guard case .string(let text)? = value else { return value }
                return .string(JavaScriptWhitespace.trim(text))
            }),
            [.minLength(min), .maxLength(max)])
    }

    /// `z.number().int().positive()`.
    static let positiveInt = Zod.checked(.number, [.int, positive])

    /// `z.number().int().nonnegative()`.
    static let nonnegativeInt = Zod.checked(.number, [.int, .min(0)])

    /// `.positive()` on a number (`>0`).
    static let positive = ZodCheck(when: nil) { value in
        guard case .number(let number)? = value, !(number > 0) else { return [] }
        return [ZodIssue(message: "Too small: expected number to be >0", continues: true)]
    }

    /// `/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/`.
    static func isWeightDecimal(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard let first = bytes.first else { return false }
        func digit(_ byte: UInt8) -> Bool { byte >= 0x30 && byte <= 0x39 }
        var index = 0
        if first == 0x30 {
            index = 1
        } else if digit(first) {
            while index < bytes.count, digit(bytes[index]) { index += 1 }
        } else {
            return false
        }
        if index == bytes.count { return true }
        guard bytes[index] == UInt8(ascii: "."), index + 1 < bytes.count else { return false }
        let fraction = bytes[(index + 1)...]
        return fraction.allSatisfy(digit) && fraction.last != 0x30
    }

    /// `decimalSchema`: the canonical weight text, at most 12 fractional digits, at most 100.
    static let decimal = Zod.checked(.string, [
        .format("Invalid string: must match pattern /^(?:0|[1-9]\\d*)(?:\\.\\d*[1-9])?$/") { isWeightDecimal($0) },
        .refine("Weight supports at most 12 fractional digits") { value in
            guard let text = value?.stringValue else { return true }
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            return (parts.count > 1 ? parts[1].count : 0) <= 12
        },
        .refine("Weight must not exceed 100") { value in
            guard let text = value?.stringValue else { return true }
            return JSValue.string(text).javaScriptNumber <= 100
        },
    ])

    /// `z.string().regex(/^[A-Z]{n}$/)`.
    static func upperLetters(_ count: Int) -> Zod {
        .checked(.string, [
            .format("Invalid string: must match pattern /^[A-Z]{\(count)}$/") { text in
                text.utf8.count == count && text.utf8.allSatisfy { $0 >= 65 && $0 <= 90 }
            }
        ])
    }

    /// `z.iso.datetime({ offset: true })` then the UTC `Z` refine.
    static let dateTime = Zod.checked(.string, [
        .format("Invalid ISO datetime") { isISODateTime($0) },
        .refine("Datetime must use UTC Z notation") { value in
            (value?.stringValue).map { $0.hasSuffix("Z") } ?? true
        },
    ])

    /// `z.url()`: an absolute URL with a scheme and a host.
    static let url = Zod.checked(.string, [
        .format("Invalid URL") { text in
            guard let components = URLComponents(string: text), let scheme = components.scheme, !scheme.isEmpty
            else { return false }
            return !(components.host ?? "").isEmpty
        }
    ])

    /// zod's ISO datetime with an offset: `YYYY-MM-DDTHH:MM[:SS[.fraction]]` then `Z` or
    /// `±HH:MM`.
    static func isISODateTime(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count >= 17, bytes[10] == UInt8(ascii: "T"),
            Zod.isISODate(String(decoding: bytes[0..<10], as: UTF8.self))
        else { return false }
        func digits(_ range: Range<Int>) -> Bool {
            range.upperBound <= bytes.count && range.allSatisfy { bytes[$0] >= 0x30 && bytes[$0] <= 0x39 }
        }
        func number(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 0x30) } }
        guard digits(11..<13), bytes[13] == UInt8(ascii: ":"), digits(14..<16),
            number(11..<13) <= 23, number(14..<16) <= 59
        else { return false }
        var index = 16
        if index < bytes.count, bytes[index] == UInt8(ascii: ":") {
            guard digits((index + 1)..<(index + 3)), number((index + 1)..<(index + 3)) <= 59 else { return false }
            index += 3
            if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
                let start = index + 1
                index = start
                while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 { index += 1 }
                if index == start { return false }
            }
        }
        guard index < bytes.count else { return false }
        if bytes[index] == UInt8(ascii: "Z") { return index + 1 == bytes.count }
        guard bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-"),
            index + 6 == bytes.count, digits((index + 1)..<(index + 3)),
            bytes[index + 3] == UInt8(ascii: ":"), digits((index + 4)..<(index + 6))
        else { return false }
        return true
    }

    // MARK: - Objects

    static let identifierTypes = ["isin", "ticker", "sedol", "cusip", "lei", "proprietary"]

    /// `identifierSchema`.
    static let identifier = Zod.checked(
        .strictObject([
            ("type", .enumeration(identifierTypes)),
            ("value", trimmed(max: 128)),
            ("exchange", trimmed(max: 64).optional),
        ]),
        [
            .superRefine { value in
                guard let fields = value?.objectValue else { return [] }
                var issues: [ZodIssue] = []
                let type = fields["type"]?.stringValue
                if type != "ticker", fields.has("exchange") {  // lint:allow string-literal-compare the contract's identifier enum
                    issues.append(ZodIssue(path: [.key("exchange")], message: "Only ticker identifiers may declare an exchange"))
                }
                if type == "isin", !ExposureArea.isCanonicalISIN(fields["value"]?.stringValue ?? "") {  // lint:allow string-literal-compare as above
                    issues.append(ZodIssue(path: [.key("value")], message: "ISIN must use its 12-character canonical form"))
                }
                return issues
            }
        ])

    /// `${type}:${exchange ?? ""}:${value}` of one parsed identifier.
    static func identifierKey(_ value: JSValue) -> String {
        let fields = value.objectValue ?? JSObject()
        return "\(fields["type"]?.stringValue ?? ""):\(fields["exchange"]?.stringValue ?? ""):\(fields["value"]?.stringValue ?? "")"
    }

    static func hasDuplicates(_ keys: [String]) -> Bool {
        var seen: Set<String> = []
        for key in keys where !seen.insert(key).inserted { return true }
        return false
    }

    /// `identitySchema`'s shape.
    static let identityShape: [(String, Zod)] = [
        ("name", trimmed(max: 256)),
        ("identifiers", .array(identifier, min: 1, max: 16)),
    ]

    /// `identitySchema`'s unique-identifier refine.
    static let uniqueIdentifiers = ZodCheck.superRefine { value in
        let identifiers = value?.objectValue?["identifiers"]?.arrayValue ?? []
        guard hasDuplicates(identifiers.map(identifierKey)) else { return [] }
        return [ZodIssue(path: [.key("identifiers")], message: "Identity identifiers must be unique")]
    }

    static let identity = Zod.checked(.strictObject(identityShape), [uniqueIdentifiers])

    /// `identitySchema.extend({ currency })`: zod 4 keeps the refinement on extend.
    static let shareClass = Zod.checked(
        .strictObject(identityShape + [("currency", upperLetters(3))]), [uniqueIdentifiers])

    static let source = Zod.checked(
        .strictObject([
            ("kind", .literal(.string("user-supplied-file"))),
            ("providerName", trimmed(max: 160).optional),
            ("fileName", trimmed(max: 512)),
            ("sourceUrl", url.optional),
            ("asOfDate", Zod.isoDate),
            ("retrievedAt", dateTime),
            ("license", .strictObject([
                ("status", .enumeration(["user-provided", "permission-confirmed", "unknown", "restricted"])),
                ("redistribution", .enumeration(["allowed", "forbidden", "unknown"])),
                ("termsUrl", url.optional),
                ("note", trimmed(max: 1_000).optional),
            ])),
        ]),
        [
            .superRefine { value in
                let license = value?.objectValue?["license"]?.objectValue ?? JSObject()
                let status = license["status"]?.stringValue
                let redistribution = license["redistribution"]?.stringValue
                var issues: [ZodIssue] = []
                if redistribution == "allowed", status != "permission-confirmed" {  // lint:allow string-literal-compare the contract's enum values
                    issues.append(ZodIssue(
                        path: [.key("license"), .key("redistribution")],
                        message: "Redistribution requires confirmed permission"))
                }
                if status == "restricted", redistribution != "forbidden" {  // lint:allow string-literal-compare the contract's enum values
                    issues.append(ZodIssue(
                        path: [.key("license"), .key("redistribution")],
                        message: "Restricted material must forbid redistribution"))
                }
                return issues
            }
        ])

    static let unsupportedKinds: Set<String> = ["nested-fund", "derivative", "synthetic", "unknown"]

    static let holding = Zod.checked(
        .strictObject([
            ("provenance", .strictObject([
                ("rowNumber", positiveInt),
                ("sheetName", trimmed(max: 128).optional),
            ])),
            ("name", trimmed(max: 256)),
            ("identifiers", .array(identifier, max: 16)),
            ("instrumentType", .enumeration(["equity", "bond", "cash", "fund", "derivative", "other"])),
            ("exposureKind", .enumeration(["direct", "cash", "nested-fund", "derivative", "synthetic", "unknown"])),
            ("exposureStatus", .enumeration(["supported", "unsupported"])),
            ("unsupportedReason", trimmed(max: 500).optional),
            ("weightPercent", decimal),
            ("currency", upperLetters(3).optional),
            ("countryCode", upperLetters(2).optional),
        ]),
        [
            .superRefine { value in
                guard let fields = value?.objectValue else { return [] }
                var issues: [ZodIssue] = []
                if fields["instrumentType"]?.stringValue != "cash", (fields["identifiers"]?.arrayValue ?? []).isEmpty {
                    issues.append(ZodIssue(path: [.key("identifiers")], message: "Non-cash holdings require an identifier"))
                }
                let kind = fields["exposureKind"]?.stringValue ?? ""
                let unsupported = fields["exposureStatus"]?.stringValue == "unsupported"  // lint:allow string-literal-compare the contract's enum values
                if unsupportedKinds.contains(kind), !unsupported {
                    issues.append(ZodIssue(path: [.key("exposureStatus")], message: "\(kind) exposure must be unsupported"))
                }
                if unsupported != fields.has("unsupportedReason") {
                    issues.append(ZodIssue(
                        path: [.key("unsupportedReason")],
                        message: "Unsupported exposure requires a reason; supported exposure forbids one"))
                }
                return issues
            }
        ])

    static let coverage = Zod.strictObject([
        ("status", .enumeration(["complete", "partial"])),
        ("reportedWeightPercent", decimal),
        ("supportedWeightPercent", decimal),
        ("unsupportedWeightPercent", decimal),
        ("missingWeightPercent", decimal),
    ])

    static let staleness = Zod.checked(
        .strictObject([
            ("evaluatedAt", Zod.isoDate),
            ("maximumAgeDays", nonnegativeInt),
            ("ageDays", nonnegativeInt),
            ("status", .enumeration(["current", "stale"])),
        ]),
        [
            .superRefine { value in
                guard let fields = value?.objectValue else { return [] }
                let age = fields["ageDays"]?.javaScriptNumber ?? 0
                let maximum = fields["maximumAgeDays"]?.javaScriptNumber ?? 0
                let expected = age > maximum ? "stale" : "current"
                guard fields["status"]?.stringValue != expected else { return [] }
                return [ZodIssue(path: [.key("status")], message: "Staleness status must be \(expected)")]
            }
        ])

    /// `fundHoldingsDocumentSchema`.
    static let document = Zod.checked(
        .strictObject([
            ("contractVersion", .literal(.number(1))),
            ("fund", identity),
            ("shareClass", shareClass),
            ("source", source),
            ("holdings", .array(holding, min: 1, max: 100_000)),
            ("coverage", coverage),
            ("staleness", staleness),
        ]),
        [.superRefine { documentIssues($0) }])

    // MARK: - The document refine

    /// `Date.parse` of a validated `YYYY-MM-DD` (as UTC midnight) or ISO datetime, in ms.
    static func epochMs(_ text: String) -> Double? {
        let bytes = Array(text.utf8)
        guard bytes.count >= 10, Zod.isISODate(String(decoding: bytes[0..<10], as: UTF8.self)) else { return nil }
        func number(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 0x30) } }
        let days = daysFromCivil(number(0..<4), number(5..<7), number(8..<10))
        var ms = Double(days) * 86_400_000
        guard bytes.count > 10 else { return ms }
        guard isISODateTime(text) else { return nil }
        ms += Double(number(11..<13)) * 3_600_000 + Double(number(14..<16)) * 60_000
        var index = 16
        if bytes[index] == UInt8(ascii: ":") {
            ms += Double(number(17..<19)) * 1_000
            index = 19
            if bytes[index] == UInt8(ascii: ".") {
                var scale = 100.0
                index += 1
                while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
                    ms += Double(bytes[index] - 0x30) * scale
                    scale /= 10
                    index += 1
                }
                ms = ms.rounded(.down)
            }
        }
        if bytes[index] != UInt8(ascii: "Z") {
            let sign: Double = bytes[index] == UInt8(ascii: "-") ? -1 : 1
            let offset = Double(number((index + 1)..<(index + 3))) * 3_600_000
                + Double(number((index + 4)..<(index + 6))) * 60_000
            ms -= sign * offset
        }
        return ms
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date.
    static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// `asScaledInteger(value, 12)` of a validated weight.
    static func scaled(_ text: String) -> Int128 {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let whole = Int128(String(parts[0])) ?? 0
        var fraction = parts.count > 1 ? String(parts[1]) : ""
        while fraction.count < 12 { fraction += "0" }
        return whole * 1_000_000_000_000 + (Int128(fraction) ?? 0)
    }

    static func documentIssues(_ value: JSValue?) -> [ZodIssue] {
        guard let document = value?.objectValue else { return [] }
        var issues: [ZodIssue] = []
        let source = document["source"]?.objectValue ?? JSObject()
        let stalenessBlock = document["staleness"]?.objectValue ?? JSObject()
        let coverageBlock = document["coverage"]?.objectValue ?? JSObject()
        let holdings = (document["holdings"]?.arrayValue ?? []).map { $0.objectValue ?? JSObject() }

        let asOfStart = epochMs(source["asOfDate"]?.stringValue ?? "") ?? .nan
        let retrievedAt = epochMs(source["retrievedAt"]?.stringValue ?? "") ?? .nan
        let evaluatedAt = epochMs(stalenessBlock["evaluatedAt"]?.stringValue ?? "") ?? .nan
        if retrievedAt < asOfStart {
            issues.append(ZodIssue(
                path: [.key("source"), .key("retrievedAt")],
                message: "Retrieval time cannot precede the holdings as-of date"))
        }
        let expectedAgeDays = ((evaluatedAt - asOfStart) / 86_400_000).rounded(.down)
        let ageDays = stalenessBlock["ageDays"]?.javaScriptNumber ?? .nan
        if expectedAgeDays < 0 || ageDays != expectedAgeDays {
            issues.append(ZodIssue(
                path: [.key("staleness"), .key("ageDays")],
                message: "Age must equal whole UTC days from as-of date to evaluation date"))
        }
        let rowKeys = holdings.map { holding -> String in
            let provenance = holding["provenance"]?.objectValue ?? JSObject()
            let row = provenance["rowNumber"].map { $0.javaScriptString } ?? ""
            return "\(provenance["sheetName"]?.stringValue ?? ""):\(row)"
        }
        if hasDuplicates(rowKeys) {
            issues.append(ZodIssue(path: [.key("holdings")], message: "Holding row numbers must be unique"))
        }
        let identifierKeys = holdings.flatMap { ($0["identifiers"]?.arrayValue ?? []).map(identifierKey) }
        if hasDuplicates(identifierKeys) {
            issues.append(ZodIssue(
                path: [.key("holdings")], message: "Constituent identifiers must be unique across rows"))
        }

        func weight(_ holding: JSObject) -> Int128 { scaled(holding["weightPercent"]?.stringValue ?? "0") }
        func coverageWeight(_ key: String) -> Int128 { scaled(coverageBlock[key]?.stringValue ?? "0") }
        let total = holdings.reduce(Int128(0)) { $0 + weight($1) }
        let supported = holdings.filter { $0["exposureStatus"]?.stringValue == "supported" }  // lint:allow string-literal-compare the contract's enum values
            .reduce(Int128(0)) { $0 + weight($1) }
        let unsupported = holdings.filter { $0["exposureStatus"]?.stringValue == "unsupported" }  // lint:allow string-literal-compare the contract's enum values
            .reduce(Int128(0)) { $0 + weight($1) }
        let reported = coverageWeight("reportedWeightPercent")
        let missing = coverageWeight("missingWeightPercent")
        if total != reported {
            issues.append(ZodIssue(
                path: [.key("coverage"), .key("reportedWeightPercent")],
                message: "Reported weight must equal the sum of holding rows"))
        }
        if supported != coverageWeight("supportedWeightPercent") {
            issues.append(ZodIssue(
                path: [.key("coverage"), .key("supportedWeightPercent")],
                message: "Supported weight must equal supported holding rows"))
        }
        if unsupported != coverageWeight("unsupportedWeightPercent") {
            issues.append(ZodIssue(
                path: [.key("coverage"), .key("unsupportedWeightPercent")],
                message: "Unsupported weight must equal unsupported holding rows"))
        }
        if reported + missing != scaled("100") {
            issues.append(ZodIssue(
                path: [.key("coverage"), .key("missingWeightPercent")],
                message: "Reported and missing weight must total 100"))
        }
        let expectedCoverage = missing == 0 && unsupported == 0 ? "complete" : "partial"
        if coverageBlock["status"]?.stringValue != expectedCoverage {
            issues.append(ZodIssue(
                path: [.key("coverage"), .key("status")], message: "Coverage status must be \(expectedCoverage)"))
        }
        return issues
    }

    // MARK: - The route's issues

    /// The zod issue code a message stands for, as the exposure route reports issues.
    static func code(of issue: ZodIssue) -> String {
        let message = issue.message
        if issue.isUnrecognizedKeys { return "unrecognized_keys" }
        if message.hasPrefix("Invalid input: expected nonoptional") { return "invalid_type" }
        if message.hasPrefix("Invalid input: expected int") { return "invalid_type" }
        if message.hasPrefix("Invalid input: expected \"") || message.hasPrefix("Invalid option") { return "invalid_value" }
        if message.hasPrefix("Invalid input: expected ") {
            return message.contains(", received") ? "invalid_type" : "invalid_value"
        }
        if message.hasPrefix("Too small") { return "too_small" }
        if message.hasPrefix("Too big") { return "too_big" }
        if message.hasPrefix("Invalid string") || message.hasPrefix("Invalid ISO") || message == "Invalid URL" {  // lint:allow string-literal-compare zod's fixed message text
            return "invalid_format"
        }
        return "custom"
    }

    /// The document's issues under `prefix`, in the exposure route's issue shape.
    static func validate(_ value: JSValue?, at prefix: [ExposureArea.Issue.Either]) -> [ExposureArea.Issue] {
        guard case .failure(let failure) = document.parse(value) else { return [] }
        return failure.issues.map { issue in
            let path = prefix + issue.path.map { element -> ExposureArea.Issue.Either in
                switch element {
                case .key(let key): return .key(key)
                case .index(let index): return .index(index)
                }
            }
            var keys: [String]? = nil
            if issue.isUnrecognizedKeys {
                // `Unrecognized key(s): "a", "b"` back to its keys.
                let list = issue.message.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
                keys = list.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                }
            }
            return ExposureArea.Issue(code: code(of: issue), path: path, message: issue.message, keys: keys)
        }
    }
}
