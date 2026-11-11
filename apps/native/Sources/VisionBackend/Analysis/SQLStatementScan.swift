import Foundation

/// `scanSql` of `database/sqlite/sqlText.ts`: rewrites `$N` placeholders to `?N` outside quotes
/// and comments, and reports the first keyword, whether the text can only read, and whether it
/// holds more than one statement. The analysis sandbox refuses a statement by these answers.
struct SQLStatementScan: Equatable {
    /// The text with `$N` placeholders rewritten.
    let text: String
    let readOnly: Bool
    let multipleStatements: Bool
    let firstKeyword: String

    static let writeWords: Set<String> = [
        "INSERT", "UPDATE", "DELETE", "UPSERT", "CREATE", "DROP", "ALTER", "PRAGMA", "VACUUM", "ANALYZE", "REINDEX",
        "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH",
    ]
    static let readStarts: Set<String> = ["SELECT", "WITH", "VALUES", "EXPLAIN"]
    /// The first keywords the analysis sandbox runs (`READ_STATEMENTS` of `analysisSandbox.ts`).
    static let sandboxStarts: Set<String> = ["SELECT", "WITH", "VALUES"]

    init(_ sql: String) {
        typealias Rules = AnalysisSQLRules
        let units = Array(sql.utf16)
        let n = units.count
        func unit(_ character: Character) -> UInt16 { Rules.unit(character) }
        func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
        func index(of target: [UInt16], from start: Int) -> Int? {
            guard start <= n - target.count else { return nil }
            return (start...(n - target.count)).first { Array(units[$0..<($0 + target.count)]) == target }
        }
        var out: [UInt16] = []
        out.reserveCapacity(n)
        var i = 0
        var firstKeyword = ""
        var sawWrite = false
        var statementEnded = false
        var multiple = false
        while i < n {
            let c = units[i]
            let next: UInt16 = i + 1 < n ? units[i + 1] : 0
            if c == unit("'") || c == unit("\"") || c == unit("`") {
                var j = i + 1
                while j < n {
                    if units[j] == c {
                        if j + 1 < n, units[j + 1] == c {
                            j += 2
                            continue
                        }
                        break
                    }
                    j += 1
                }
                if statementEnded { multiple = true }
                let end = min(j + 1, n)
                out += units[i..<end]
                i = j + 1
                continue
            }
            if c == unit("[") {
                let end = index(of: [unit("]")], from: i + 1).map { $0 + 1 } ?? n
                if statementEnded { multiple = true }
                out += units[i..<end]
                i = end
                continue
            }
            if c == unit("-"), next == unit("-") {
                let end = index(of: [unit("\n")], from: i) ?? n
                out += units[i..<end]
                i = end
                continue
            }
            if c == unit("/"), next == unit("*") {
                let end = index(of: [unit("*"), unit("/")], from: i + 2).map { $0 + 2 } ?? n
                out += units[i..<end]
                i = end
                continue
            }
            if c == unit("$"), isDigit(next) {
                var j = i + 1
                while j < n, isDigit(units[j]) { j += 1 }
                if statementEnded { multiple = true }
                out.append(unit("?"))
                out += units[(i + 1)..<j]
                i = j
                continue
            }
            if c == unit(";") {
                statementEnded = true
                out.append(c)
                i += 1
                continue
            }
            if Rules.isWord(c), i == 0 || !Rules.isWord(units[i - 1]) {
                var j = i
                while j < n, Rules.isWord(units[j]) { j += 1 }
                let word = Rules.text(units[i..<j]).uppercased()
                if statementEnded { multiple = true }
                if firstKeyword.isEmpty, let first = word.utf16.first, first >= 0x41, first <= 0x5A { firstKeyword = word }
                if Self.writeWords.contains(word) {
                    sawWrite = true
                } else if word == "REPLACE" {
                    let after = Rules.skipSpaces(units, from: j)
                    if !(after < n && units[after] == unit("(")) { sawWrite = true }
                }
                out += units[i..<j]
                i = j
                continue
            }
            if statementEnded, !Rules.isSpace(c) { multiple = true }
            out.append(c)
            i += 1
        }
        text = Rules.text(out[...])
        readOnly = Self.readStarts.contains(firstKeyword) && !sawWrite
        multipleStatements = multiple
        self.firstKeyword = firstKeyword
    }
}
