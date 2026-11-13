import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/portfolio-import.jsonl`: the sample statements of the backend tests
/// and generated variations of them through the portfolio statement adapters that read CSV
/// (`portfolioImportPipeline`), plus the type normaliser and the upload checks, with what the
/// TypeScript answered (`bun run native:parity-plans`).
@Suite struct PortfolioAdapterParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("portfolio-import.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func bytes(_ value: JSValue?) -> [UInt8] {
        Array(Data(base64Encoded: value?.stringValue ?? "") ?? Data())
    }

    private static func config(_ wire: JSObject?) -> PortfolioParserConfig {
        let mapping = wire?["column_mapping"]?.objectValue
        func column(_ key: String) -> String? { mapping?[key]?.stringValue }
        var config = PortfolioParserConfig()
        config.format = wire?["format"]?.stringValue.flatMap(PortfolioParserConfig.Format.init(rawValue:))
        config.dateFormat = wire?["date_format"]?.stringValue
        config.separator = wire?["separator"]?.stringValue
        config.skipRows = wire?["skip_rows"].map { Int($0.javaScriptNumber) } ?? 0
        config.encoding = wire?["encoding"]?.stringValue
        config.numberFormat = wire?["number_format"]
        config.zeroYieldBasis = wire?["yield_basis_policy"]?.stringValue == "zero"
        // `Number(value)`: null is 0, which is no account.
        config.transferOriginAccount = wire?["transfer_origin_account_id"].map { $0 == .null ? 0 : $0.javaScriptNumber }
        config.columns = .init(
            date: column("date"), type: column("type"), symbol: column("symbol"), name: column("name"),
            units: column("units"), price: column("price"), amount: column("amount"), fees: column("fees"),
            taxes: column("taxes"), currency: column("currency"), fxRate: column("fx_rate"), note: column("note"),
            sourceAccount: column("source_account"), sourceReference: column("source_id"))
        return config
    }

    private static func failure(_ kind: String, _ pairs: (String, JSValue)...) -> JSValue {
        .object(JSObject([("error", .string(kind))] + pairs))
    }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        do {
            switch name {
            case "portfolio": return try PortfolioAdapters.parse(bytes(at(1)), config(at(2)?.objectValue)).jsonValue
            case "type":
                var mapping: [String: String] = [:]
                for (key, value) in at(2)?.objectValue?.entries ?? [] { mapping[key] = value.stringValue ?? "" }
                switch PortfolioTypeNormalizer.normalize(at(1)?.stringValue, mapping: mapping, defaultType: at(3)?.stringValue) {
                case .type(let type): return .object(JSObject([("type", .string(type))]))
                case .error(let message): return .object(JSObject([("error", .string(message))]))
                }
            case "format": return .string(PortfolioUpload.format(of: bytes(at(1))).rawValue)
            case "likely":
                return .bool(PortfolioUpload.isLikelyStatement(name: at(1)?.stringValue, mimeType: at(2)?.stringValue))
            default: throw UnknownOperation(name: name)
            }
        } catch let error as StatementImportError {
            switch error {
            case .validation(let message): return failure("validation", ("message", .string(message)))
            case .failed(let message): return failure("failed", ("message", .string(message)))
            case .contract: return failure("contract")
            }
        } catch let error as CSVParse.Failure {
            return failure("csv", ("code", .string(error.code.rawValue)))
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op))
            let want = PlanFixture.canonical(recorded["r"] ?? .null)
            // By code unit: Swift's `==` takes canonically equivalent text for equal.
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 12 {
                    failures.append("line \(index + 1)\n  want \(want.prefix(1500))\n  got  \(got.prefix(1500))")
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 300)
    }
}
