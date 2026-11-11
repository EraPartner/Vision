import Foundation

/// The rules that decide which SQL an analysis may run: `checkAnalysisSql`, `maskSql`,
/// `referencedViews`, `columnKind`, `storedValueHint` and `checkParameters` of
/// `services/analysisExecutor.ts`.
///
/// The TypeScript tests the text with JavaScript regular expressions over UTF-16 code units,
/// where `/i` folds ASCII letters only (`K` U+212A is not `k`) and `\b`, `\s` have fixed sets.
/// The checks are written out by hand here so that no regular-expression engine with other
/// folding or boundary rules decides what is allowed.
enum AnalysisSQLRules {
    /// A statement the rules refuse; `message` is the TypeScript error's message.
    struct Violation: Error, Equatable {
        let message: String
    }

    struct Checked: Equatable {
        /// The statement to run: the input, trimmed, without a final semicolon.
        let sql: String
        /// The same text with comments and strings blanked out.
        let masked: String
    }

    static let maxBytes = 100_000

    /// `RELATIONS_BY_DATASET`, in declaration order.
    static let relationsByDataset: [(id: String, relations: [String])] = [
        ("transactions", ["vision_analysis.transactions_v1", "vision_analysis.transactions_v2"]),
        ("accounts", ["vision_analysis.accounts_v1"]),
        ("holdings", ["vision_analysis.holding_events_v1"]),
        ("cash-flows", ["vision_analysis.cash_flows_v1", "vision_analysis.cash_flows_v2"]),
    ]

    /// `APPROVED_ANALYSIS_RELATIONS` of `analysisCatalog.ts`.
    static let approvedRelations: Set<String> = [
        "vision_analysis.transactions_v2", "vision_analysis.accounts_v1", "vision_analysis.holding_events_v1",
        "vision_analysis.cash_flows_v2", "vision_analysis.transactions_v1", "vision_analysis.cash_flows_v1",
    ]

    static let forbiddenOperations: Set<String> = [
        "insert", "update", "delete", "merge", "create", "alter", "drop", "truncate", "copy", "call", "do", "grant",
        "revoke", "set", "reset", "vacuum", "analyze", "refresh", "lock", "listen", "notify", "prepare", "execute",
        "deallocate", "discard", "reindex", "cluster", "load", "into", "attach", "detach", "pragma", "begin", "commit",
        "rollback", "savepoint", "release",
    ]

    static let forbiddenFunctions: Set<String> = [
        "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export", "dblink",
        "pg_sleep", "set_config", "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer",
    ]

    static let forbiddenSchemas: Set<String> = [
        "pg_catalog", "information_schema", "public", "sqlite_master", "sqlite_schema", "sqlite_temp_master",
        "sqlite_temp_schema",
    ]

    static let computedColumnTypes: [String: [String: String]] = [
        "accounts_v1": ["statement_balances": "JSON_TEXT"],
        "cash_flows_v1": [
            "flow_type": "TEXT", "spending_amount": "DECIMAL_TEXT", "positive_flow_amount": "DECIMAL_TEXT",
        ],
        "cash_flows_v2": [
            "flow_type": "TEXT", "spending_amount": "DECIMAL_TEXT", "positive_flow_amount": "DECIMAL_TEXT",
            "category_path_segments": "TEXT_ARRAY", "category_path_ids": "TEXT_ARRAY",
        ],
        "holding_events_v1": ["fees": "DECIMAL_TEXT", "taxes": "DECIMAL_TEXT"],
        "transactions_v2": ["category_path_segments": "TEXT_ARRAY", "category_path_ids": "TEXT_ARRAY"],
    ]

    /// TEXT_ARRAY columns that were PostgreSQL `integer[]`.
    static let integerArrayColumns: Set<String> = ["category_path_ids"]

    // MARK: Code units

    typealias Units = [UInt16]

    static func unit(_ character: Character) -> UInt16 { character.utf16.first ?? 0 }

    /// `\w` of a JavaScript regular expression.
    static func isWord(_ u: UInt16) -> Bool {
        (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || u == 0x5F
    }

    /// `\s` of a JavaScript regular expression, which is also what `trim` removes.
    static func isSpace(_ u: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(u) else { return false }
        return JavaScriptWhitespace.contains(scalar)
    }

    static func isIdentifierStart(_ u: UInt16) -> Bool { isWord(u) && !(u >= 0x30 && u <= 0x39) }

    static func lowerASCII(_ u: UInt16) -> UInt16 { u >= 0x41 && u <= 0x5A ? u + 0x20 : u }

    static func text(_ units: Units.SubSequence) -> String { String(decoding: units, as: UTF16.self) }

    static func trimmed(_ units: Units) -> Units {
        guard let first = units.firstIndex(where: { !isSpace($0) }),
            let last = units.lastIndex(where: { !isSpace($0) })
        else { return [] }
        return Array(units[first...last])
    }

    /// `text.trim().replace(/;\s*$/, "")`: after the trim only a final semicolon can match.
    static func withoutFinalSemicolon(_ units: Units) -> Units {
        var out = trimmed(units)
        if out.last == 0x3B { out.removeLast() }
        return out
    }

    /// True when the ASCII, lower-case `word` stands at `index`, compared without case.
    static func matches(_ units: Units, _ word: String, at index: Int) -> Bool {
        var i = index
        for expected in word.utf16 {
            guard i < units.count, lowerASCII(units[i]) == expected else { return false }
            i += 1
        }
        return true
    }

    static func skipSpaces(_ units: Units, from index: Int) -> Int {
        var i = index
        while i < units.count, isSpace(units[i]) { i += 1 }
        return i
    }

    /// The maximal runs of word characters, as lower-case text with the index after each run.
    static func wordRuns(_ units: Units) -> [(word: String, end: Int)] {
        var runs: [(String, Int)] = []
        var i = 0
        while i < units.count {
            guard isWord(units[i]) else {
                i += 1
                continue
            }
            var j = i
            while j < units.count, isWord(units[j]) { j += 1 }
            runs.append((text(units[i..<j]).lowercased(), j))
            i = j
        }
        return runs
    }

    // MARK: Masking

    private enum MaskState { case code, line, block, single, identifier }

    /// `maskSql`: comments and string literals become blanks, identifier quotes become `"`.
    static func mask(_ sql: String) -> String { text(mask(Array(sql.utf16))[...]) }

    static func mask(_ sql: Units) -> Units {
        let space = unit(" ")
        let newline = unit("\n")
        let quote = unit("\"")
        var out: Units = []
        out.reserveCapacity(sql.count)
        var state = MaskState.code
        var close: UInt16 = 0
        var i = 0
        while i < sql.count {
            let ch = sql[i]
            let next: UInt16? = i + 1 < sql.count ? sql[i + 1] : nil
            defer { i += 1 }
            switch state {
            case .line:
                if ch == newline {
                    state = .code
                    out.append(newline)
                } else {
                    out.append(space)
                }
            case .block:
                if ch == unit("*"), next == unit("/") {
                    out += [space, space]
                    i += 1
                    state = .code
                } else {
                    out.append(ch == newline ? newline : space)
                }
            case .single:
                if ch == unit("'"), next == unit("'") {
                    out += [space, space]
                    i += 1
                } else if ch == unit("'") {
                    out.append(space)
                    state = .code
                } else {
                    out.append(ch == newline ? newline : space)
                }
            case .identifier:
                if ch == close, close != unit("]"), next == close {
                    out += [ch, ch]
                    i += 1
                } else if ch == close {
                    out.append(quote)
                    state = .code
                } else {
                    out.append(ch)
                }
            case .code:
                if ch == unit("-"), next == unit("-") {
                    out += [space, space]
                    i += 1
                    state = .line
                } else if ch == unit("/"), next == unit("*") {
                    out += [space, space]
                    i += 1
                    state = .block
                } else if ch == unit("'") {
                    out.append(space)
                    state = .single
                } else if ch == quote || ch == unit("`") || ch == unit("[") {
                    out.append(quote)
                    close = ch == unit("[") ? unit("]") : ch
                    state = .identifier
                } else {
                    out.append(ch)
                }
            }
        }
        return out
    }

    // MARK: The check

    /// `checkAnalysisSql`. `sql` is nil when the caller's value is not a string.
    static func check(_ sql: String?, datasetIds: [String]) throws -> Checked {
        guard let sql, !JavaScriptWhitespace.trim(sql).isEmpty else { throw Violation(message: "SQL is required") }
        if sql.utf8.count > maxBytes { throw Violation(message: "SQL exceeds the 100 KB limit") }
        let maskedUnits = mask(Array(sql.utf16))
        let trimmed = withoutFinalSemicolon(maskedUnits)
        guard
            ["select", "with", "values"].contains(where: { word in
                matches(trimmed, word, at: 0) && (word.utf16.count == trimmed.count || !isWord(trimmed[word.utf16.count]))
            })
        else { throw Violation(message: "Only SELECT queries are allowed") }
        if trimmed.contains(0x3B) { throw Violation(message: "Exactly one SQL statement is allowed") }
        let runs = wordRuns(trimmed)
        if runs.contains(where: { forbiddenOperations.contains($0.word) }) {
            throw Violation(message: "SQL contains a forbidden operation")
        }
        func follows(_ run: (word: String, end: Int), _ character: Character) -> Bool {
            let next = skipSpaces(trimmed, from: run.end)
            return next < trimmed.count && trimmed[next] == unit(character)
        }
        if runs.contains(where: { run in
            (forbiddenFunctions.contains(run.word) || (run.word.hasPrefix("pragma_") && run.word.utf16.count > 7))
                && follows(run, "(")
        }) {
            throw Violation(message: "SQL contains a forbidden function")
        }
        if runs.contains(where: { forbiddenSchemas.contains($0.word) && follows($0, ".") }) {
            throw Violation(message: "Only approved analysis datasets may be queried")
        }
        if datasetIds.isEmpty { throw Violation(message: "At least one approved dataset must be declared") }
        let cteNames = commonTableNames(trimmed)
        let relations = relationNames(trimmed)
        for relation in relations where !cteNames.contains(relation) && !approvedRelations.contains(relation) {
            throw Violation(message: "Relation is not an approved analysis dataset: \(relation)")
        }
        if let unknown = datasetIds.first(where: { id in !relationsByDataset.contains { $0.id == id } }) {
            throw Violation(message: "Dataset is not approved: \(unknown)")
        }
        let expected = Set(declaredRelations(datasetIds))
        if relations.contains(where: { !cteNames.contains($0) && !expected.contains($0) }) {
            throw Violation(message: "SQL references a dataset not declared by the analysis")
        }
        return Checked(
            sql: text(withoutFinalSemicolon(Array(sql.utf16))[...]), masked: text(maskedUnits[...]))
    }

    static func declaredRelations(_ datasetIds: [String]) -> [String] {
        datasetIds.flatMap { id in relationsByDataset.first { $0.id == id }?.relations ?? [] }
    }

    /// The names matched by `/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi`, lower-cased.
    static func commonTableNames(_ units: Units) -> Set<String> {
        var names: Set<String> = []
        var p = 0
        while p < units.count {
            if let match = commonTableName(units, at: p) {
                names.insert(match.name)
                p = match.end
            } else {
                p += 1
            }
        }
        return names
    }

    private static func commonTableName(_ units: Units, at p: Int) -> (name: String, end: Int)? {
        var i: Int
        if units[p] == unit(",") {
            i = p + 1
        } else if matches(units, "with", at: p), p == 0 || !isWord(units[p - 1]),
            p + 4 == units.count || !isWord(units[p + 4])
        {
            i = p + 4
        } else {
            return nil
        }
        i = skipSpaces(units, from: i)
        guard i < units.count, isIdentifierStart(units[i]) else { return nil }
        var j = i
        while j < units.count, isWord(units[j]) { j += 1 }
        var k = skipSpaces(units, from: j)
        guard k > j, matches(units, "as", at: k) else { return nil }
        k = skipSpaces(units, from: k + 2)
        guard k < units.count, units[k] == unit("(") else { return nil }
        return (text(units[i..<j]).lowercased(), k + 1)
    }

    /// The relations after FROM and JOIN: each match of
    /// `/\b(?:from|join)\s+((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))?)/gi`
    /// without quotes and whitespace, lower-cased.
    static func relationNames(_ units: Units) -> [String] {
        var names: [String] = []
        var p = 0
        while p < units.count {
            guard p == 0 || !isWord(units[p - 1]), matches(units, "from", at: p) || matches(units, "join", at: p)
            else {
                p += 1
                continue
            }
            let start = skipSpaces(units, from: p + 4)
            guard start > p + 4, var end = namePart(units, at: start) else {
                p += 1
                continue
            }
            var k = skipSpaces(units, from: end)
            if k < units.count, units[k] == unit(".") {
                k = skipSpaces(units, from: k + 1)
                if let second = namePart(units, at: k) { end = second }
            }
            let kept = units[start..<end].filter { $0 != unit("\"") && !isSpace($0) }
            names.append(JavaScriptCase.lowercased(text(kept[...])))
            p = end
        }
        return names
    }

    /// `"[^"]+"` or `[a-z_][a-z0-9_]*` at `index`: the index after it.
    private static func namePart(_ units: Units, at index: Int) -> Int? {
        guard index < units.count else { return nil }
        if units[index] == unit("\"") {
            guard let close = units[(index + 1)...].firstIndex(of: unit("\"")), close > index + 1 else { return nil }
            return close + 1
        }
        guard isIdentifierStart(units[index]) else { return nil }
        var j = index
        while j < units.count, isWord(units[j]) { j += 1 }
        return j
    }

    // MARK: Views and columns

    /// `referencedViews`: the views of the declared datasets that the masked statement names.
    static func referencedViews(masked: String, datasetIds: [String]) -> [String] {
        let units = Array(masked.utf16)
        func isNamePart(_ u: UInt16) -> Bool { isWord(u) || u == unit("$") }
        var views: [String] = []
        for relation in declaredRelations(datasetIds) {
            let view = String(relation.dropFirst("vision_analysis.".count))
            guard !views.contains(view) else { continue }
            let length = view.utf16.count
            var found = false
            var p = 0
            while !found, p + length <= units.count {
                found =
                    matches(units, view, at: p) && (p == 0 || !isNamePart(units[p - 1]))
                    && (p + length == units.count || !isNamePart(units[p + length]))
                p += 1
            }
            if found { views.append(view) }
        }
        return views
    }

    /// `columnKind`: nil for a column SQLite reports without a declared type.
    static func columnKind(column: String, declaredType: String) -> String? {
        let type = JavaScriptWhitespace.trim(declaredType).uppercased()
        if type.isEmpty { return nil }
        if type == "BOOLEAN" { return "boolean" }
        if type == "BIGINT" { return "bigint" }
        if type.hasPrefix("DECIMAL_TEXT") { return "decimal" }
        if type == "DATE_TEXT" { return "date" }
        if type == "TIMESTAMPTZ_TEXT" { return "datetime" }
        if type == "JSON_TEXT" || type == "JSONB_TEXT" { return "json" }
        if type == "TEXT_ARRAY" { return integerArrayColumns.contains(column) ? "integer[]" : "string[]" }
        if type.contains("INT") { return "integer" }
        if type == "REAL" { return "decimal" }
        return "string"
    }

    /// `storedValueHint`: the alias hint that reads a column's stored value unchanged.
    static func storedValueHint(declaredType: String) -> String {
        let type = JavaScriptWhitespace.trim(declaredType).uppercased()
        if type == "BOOLEAN" || type.contains("INT") { return "::bigint" }
        if ["DATE_TEXT", "TIMESTAMPTZ_TEXT", "JSON_TEXT", "JSONB_TEXT", "TEXT_ARRAY"].contains(type) { return "::text" }
        return ""
    }

    /// `checkParameters`: scalars only, a boolean bound as 1 or 0. NaN cannot be bound.
    static func checkParameters(_ values: JSValue?) throws -> [JSValue] {
        guard case .array(let items)? = values else { throw Violation(message: "SQL parameters must be scalar values") }
        for item in items {
            switch item {
            case .null, .string, .number, .bool: continue
            default: throw Violation(message: "SQL parameters must be scalar values")
            }
        }
        return try items.map { item in
            switch item {
            case .bool(let flag): return .number(flag ? 1 : 0)
            case .number(let number) where number.isNaN: throw Violation(message: "NaN cannot be bound to SQLite")
            default: return item
            }
        }
    }
}

/// `String.prototype.toLowerCase`: the Unicode default mapping, with the final-sigma rule.
enum JavaScriptCase {
    static func lowercased(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        if scalars.allSatisfy(\.isASCII) { return text.lowercased() }
        var out = ""
        for (index, scalar) in scalars.enumerated() {
            if scalar.value == 0x3A3 {
                out += isFinalSigma(scalars, index) ? "\u{3C2}" : "\u{3C3}"
            } else {
                out += scalar.properties.lowercaseMapping
            }
        }
        return out
    }

    /// Final_Sigma of the Unicode special-casing rules: a cased letter before (case-ignorable
    /// characters skipped) and none after.
    private static func isFinalSigma(_ scalars: [Unicode.Scalar], _ index: Int) -> Bool {
        var before = index - 1
        while before >= 0, scalars[before].properties.isCaseIgnorable { before -= 1 }
        guard before >= 0, scalars[before].properties.isCased else { return false }
        var after = index + 1
        while after < scalars.count, scalars[after].properties.isCaseIgnorable { after += 1 }
        return !(after < scalars.count && scalars[after].properties.isCased)
    }
}
