import Foundation

/// The built-in bank adapters, in registry (detection precedence) order
/// (`BANK_IMPORT_FORMATS`, packages/shared-utils/src/bankImportDetection.ts).
public enum BankImportFormat: String, CaseIterable, Sendable {
    case belfius
    case revolut
    case ing
    case bnp
    case kbc
    case vision
    case sabb
    case wise
}

/// What the budget import card recognised in a file (ADR-268).
public enum BankImportDetection: Equatable, Sendable {
    /// One source fits: a built-in adapter, or the only fitting saved parser.
    case detected(ImportSource)
    /// The file fits a built-in format and a saved parser, or several saved parsers.
    case ambiguous([ImportSource])
    case none
}

/// `bankImportDetection.ts`: the signatures the backend adapters' `detect` share, read from
/// the decoded head of a file, and the saved-parser column check.
public enum BankImportDetector {
    /// `BANK_DETECTION_PEEK_BYTES`: covers every signature.
    public static let peekBytes = 65_536
    private static let belfiusMinimumFields = 12
    /// Vision's own export column order; later columns may vary.
    private static let visionExportHeaderPrefix = ["date", "bank account", "recipient", "memo", "amount", "currency"]

    /// `detectBankImportFile`: the file's first 64 KiB, UTF-8 with the Latin-1 fallback for the
    /// built-in formats, and each saved parser's own separator, encoding and skipped rows.
    public static func detect(_ data: Data, savedParsers: [OpenAPI.CustomParserConfig]) -> BankImportDetection {
        let head = Array(data.prefix(peekBytes))
        let partial = head.count < data.count
        let formats = formats(CSVPreview.decode(head, encoding: "utf-8", partial: partial))
        let saved = savedParsers.filter { parser in
            let config = CSVParserConfig(saved: parser.config)
            // A parser whose settings cannot read this file does not fit it.
            guard let text = CSVPreview.decode(head, encoding: config.encoding, partial: partial) else { return false }
            let headers = CSVPreview.parse(text, separator: config.separator, skipRows: config.skipRows).headers
            return matchesSavedParser(
                headers: headers, columns: [
                    config.dateColumn, config.recipientColumn, config.amountColumn, config.memoColumn,
                ])
        }
        return resolve(formats: formats, saved: saved.map { .saved($0.id) })
    }

    /// `detectBankImportFormats`: every matching format, in registry order.
    public static func formats(_ sample: String?) -> [BankImportFormat] {
        BankImportFormat.allCases.filter { matches($0, sample: sample) }
    }

    /// `matchesBankImportFormat`: a leading UTF-8 BOM is never part of a header.
    public static func matches(_ format: BankImportFormat, sample: String?) -> Bool {
        guard var sample, !sample.isEmpty else { return false }
        if sample.unicodeScalars.first == "\u{FEFF}" { sample.unicodeScalars.removeFirst() }
        switch format {
        case .belfius:
            let head = lines(sample).prefix(15)
            return head.contains { $0.contains("Laatste saldo;") }
                || head.contains { line in
                    startsWithBelgianIBAN(line.trimmingCharacters(in: .whitespacesAndNewlines))
                        && line.components(separatedBy: ";").count >= belfiusMinimumFields
                }
        case .revolut:
            let lower = firstLine(sample).lowercased()
            return lower.hasPrefix("type,") && lower.contains("completed date") && lower.contains("state")
        case .ing:
            return lines(sample).prefix(3).contains {
                $0.contains("Omzetnummer") && $0.contains("Detail van de omzet")
            }
        case .bnp:
            return lines(sample).prefix(3).contains {
                $0.contains("Volgnummer") && $0.contains("Uitvoeringsdatum") && $0.contains("Valuta rekening")
            }
        case .kbc:
            let head = lines(sample).prefix(5)
            return head.contains { $0.hasPrefix("Rekeningnummer") } || head.contains { $0.contains("Vrije Mededeling") }
        case .vision:
            let columns = firstLine(sample).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                .components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            return visionExportHeaderPrefix.enumerated().allSatisfy { index, name in
                index < columns.count && columns[index] == name
            }
        case .sabb:
            let lower = firstLine(sample).lowercased()
            return lower.contains("transaction date") && lower.contains("amount(sar)")
        case .wise:
            let lower = firstLine(sample).lowercased()
            return lower.contains("direction") && lower.contains("target amount") && lower.contains("source amount")
        }
    }

    /// `matchesSavedBankParser`: every mapped column (at least three) is in the header row,
    /// compared trimmed.
    public static func matchesSavedParser(headers: [String], columns: [String]) -> Bool {
        let present = Set(headers.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
        let mapped = columns.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return mapped.count >= 3 && mapped.allSatisfy(present.contains)
    }

    /// `resolveBankImportDetection`: built-in formats alone resolve in registry order; one
    /// saved parser alone wins; a built-in format beside a saved parser, or several saved
    /// parsers, is not guessed.
    public static func resolve(formats: [BankImportFormat], saved: [ImportSource]) -> BankImportDetection {
        let format = formats.first.map { ImportSource.adapter($0.rawValue) }
        if saved.isEmpty { return format.map { .detected($0) } ?? .none }
        if format == nil, saved.count == 1, let only = saved.first { return .detected(only) }
        return .ambiguous((format.map { [$0] } ?? []) + saved)
    }

    /// `^BE\d{2}`.
    private static func startsWithBelgianIBAN(_ line: String) -> Bool {
        let scalars = Array(line.unicodeScalars.prefix(4))
        guard scalars.count == 4, scalars[0] == "B", scalars[1] == "E" else { return false }
        return scalars[2...].allSatisfy { ("0"..."9").contains($0) }
    }

    /// `sample.split(/\r\n|\r|\n/)`.
    static func lines(_ text: String) -> [String] {
        var result: [String] = []
        var current = String.UnicodeScalarView()
        var previousWasReturn = false
        for scalar in text.unicodeScalars {
            if scalar == "\n" && previousWasReturn {
                previousWasReturn = false
                continue
            }
            previousWasReturn = scalar == "\r"
            if scalar == "\r" || scalar == "\n" {
                result.append(String(current))
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        result.append(String(current))
        return result
    }

    /// `sample.split("\n")[0]`: a trailing `\r` stays, as in the web.
    static func firstLine(_ text: String) -> String {
        var line = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar == "\n" { break }
            line.append(scalar)
        }
        return String(line)
    }
}
