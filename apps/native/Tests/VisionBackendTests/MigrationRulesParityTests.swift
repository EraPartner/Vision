import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/migrations.jsonl`: the rules of `database/migrate.ts` and the boolean
/// input of `sqlite/values.ts`, with what the TypeScript answered against real SQLite databases
/// and directories (`bun run native:parity-plans`). The Swift side is given what the TypeScript
/// read from them: the file texts, the ledger rows, the directory listing.
@Suite struct MigrationRulesParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("migrations.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func items(_ value: JSValue?) -> [JSValue] {
        if case .array(let items)? = value { return items }
        return []
    }

    private static func files(_ value: JSValue?) -> [String: String]? {
        guard let wire = value?.objectValue else { return nil }
        return Dictionary(uniqueKeysWithValues: wire.entries.map { ($0.0, $0.1.stringValue ?? "") })
    }

    private static func ledger(_ value: JSValue?) -> [MigrationRules.Applied] {
        items(value).map { row in
            let cells = items(row)
            return MigrationRules.Applied(
                version: Int(cells[0].javaScriptNumber), name: cells[1].stringValue ?? "", sha256: cells[2].stringValue ?? "")
        }
    }

    private static func object(_ entries: [(String, JSValue)]) -> JSValue { .object(JSObject(entries)) }
    private static func text(_ value: String?) -> JSValue { value.map(JSValue.string) ?? .null }

    /// The directory the TypeScript ran in is recorded as `<dir>`.
    private static let directory = "<dir>/migrations"

    static func evaluate(_ op: [JSValue], recorded: JSValue?) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        do {
            switch name {
            case "load":
                let migrations = try MigrationRules.load(directory: directory, files: files(at(1)))
                return object([
                    (
                        "migrations",
                        .array(
                            migrations.map {
                                object([
                                    ("version", .int($0.version)), ("name", .string($0.name)), ("sha256", .string($0.sha256)),
                                    ("down", text($0.downSQL)),
                                ])
                            })
                    )
                ])
            case "plan":
                let migrations = try MigrationRules.load(directory: directory, files: files(at(1)))
                let pending = try MigrationRules.pending(
                    ledger: ledger(at(2)), hasApplicationObjects: op[3] == .bool(true), migrations: migrations)
                return object([("pending", .array(pending.map { .string($0.name) }))])
            case "run":
                let migrations = try MigrationRules.load(directory: directory, files: files(at(1)))
                let run = try MigrationRules.run(
                    ledger: ledger(at(2)), hasApplicationObjects: op[3] == .bool(true), migrations: migrations,
                    targetVersion: at(4).map { Int($0.javaScriptNumber) }, skipBackup: op[5] == .bool(true),
                    databaseFile: op[6] == .bool(true) ? "<dir>/vision.sqlite3" : ":memory:")
                return object([
                    ("revision", text(run.revision)), ("applied", .array(run.pending.map { .string($0.name) })),
                    ("backup", .bool(run.backup != nil)),
                ])
            case "revert":
                // The TypeScript migrated a new file up to the given version, then reverted once.
                let migrations = try MigrationRules.load(directory: directory, files: files(at(1)))
                let applied = migrations.prefix(Int(at(2)?.javaScriptNumber ?? 0)).map {
                    MigrationRules.Applied(version: $0.version, name: $0.name, sha256: $0.sha256)
                }
                let reverted = try MigrationRules.revert(
                    ledger: Array(applied), hasApplicationObjects: !applied.isEmpty, migrations: migrations)
                return object([("revision", text(reverted.revision))])
            case "violations":
                // The rows are what SQLite reported to the TypeScript; the message is compared.
                let rows = items(recorded?.objectValue?["rows"])
                let found = MigrationRules.violations(
                    rows.map { row in
                        let cells = items(row)
                        let rowid: Int64? = cells[1] == .null ? nil : Int64(cells[1].javaScriptNumber)
                        return (cells[0].stringValue ?? "", rowid, cells[2].stringValue ?? "")
                    })
                let message: JSValue =
                    found.isEmpty ? .null : .string("Migrations left foreign key violations: \(found.joined(separator: "; "))")
                return object([("rows", .array(rows)), ("message", message)])
            case "backup":
                let file = "<dir>/" + (at(1)?.stringValue ?? "")
                return object([
                    (
                        "name",
                        .string(
                            MigrationRules.backupName(
                                databaseFile: file, from: Int(at(2)?.javaScriptNumber ?? 0), to: Int(at(3)?.javaScriptNumber ?? 0),
                                epochMs: Int64(at(4)?.javaScriptNumber ?? 0)))
                    ),
                    ("directory", .string(MigrationRules.backupDirectory(databaseFile: file))),
                ])
            case "prune":
                // The copy the TypeScript wrote is newer than the past copies and older than
                // the ones dated in the future (2100); it is left out of the answer.
                let written = "\u{0}written.sqlite3"
                var copies = items(at(1)).map { (name: items($0)[0].stringValue ?? "", modifiedMs: items($0)[1].javaScriptNumber) }
                copies.append((written, 2_000_000_000_000))
                let removed = Set(MigrationRules.copiesToRemove(copies))
                let kept = copies.map(\.name).filter { !removed.contains($0) && $0 != written }
                return .array(kept.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }.map(JSValue.string))
            case "fingerprint":
                return .string(
                    MigrationRules.schemaFingerprint(
                        items(at(1)).map { row in
                            let cells = items(row)
                            return MigrationRules.SchemaObject(
                                type: cells[0].stringValue ?? "", name: cells[1].stringValue ?? "", table: cells[2].stringValue ?? "",
                                sql: cells[3].stringValue)
                        }))
            case "boolean":
                return object([("value", try SQLBooleanInput.read(op.count > 1 ? op[1] : nil).map(JSValue.bool) ?? .null)])
            default: throw UnknownOperation(name: name)
            }
        } catch let error as MigrationError {
            return object([("error", .string(error.message))])
        } catch let error as SQLStateError {
            return object([("error", .string(error.message))])
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op, recorded: recorded["r"]))
            let want = PlanFixture.canonical(recorded["r"] ?? .null)
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 12 {
                    failures.append(
                        "line \(index + 1) \(String(line.prefix(500)))\n  want \(want.prefix(700))\n  got  \(got.prefix(700))")
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 300)
    }
}
