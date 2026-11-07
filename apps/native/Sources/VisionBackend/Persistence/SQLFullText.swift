import Foundation

// to_tsvector('simple'), websearch_to_tsquery('simple'), `@@` and ts_rank_cd (fts.ts).
extension SQLFullText {
    /// Lexeme -> sorted positions (1-based), as to_tsvector('simple', text).
    public typealias TsVector = [String: [Int]]

    /// PostgreSQL's MAXSTRLEN: longer words are dropped with a notice.
    static let maxWordBytes = 2047
    /// MAXENTRYPOS - 1: positions above it are clamped.
    static let maxPosition = 16383
    /// MAXNUMPOS - 1: positions kept per lexeme.
    static let maxPositions = 255

    /// The `simple` dictionary's lexemes of a text, with their positions in order.
    static func lexemes(_ text: String) -> [(lexeme: String, pos: Int)] {
        var out: [(lexeme: String, pos: Int)] = []
        var pos = 0
        for token in parseTokens(text) where indexed.contains(token.type) {
            if token.text.utf8.count >= maxWordBytes { continue }
            pos += 1
            let lexeme = SQLText.asciiLower(token.text)
            if lexeme.isEmpty { continue }
            out.append((lexeme, min(pos, maxPosition)))
        }
        return out
    }

    public static func toTsvector(_ text: String) -> TsVector {
        var vector: TsVector = [:]
        for (lexeme, pos) in lexemes(text) {
            var list = vector[lexeme] ?? []
            if list.count < maxPositions, list.last != pos { list.append(pos) }
            vector[lexeme] = list
        }
        return vector
    }

    static func quoteLexeme(_ text: String) -> String {
        var out = "'"
        for scalar in text.unicodeScalars {
            if scalar == "'" || scalar == "\\" { out.unicodeScalars.append(scalar) }
            out.unicodeScalars.append(scalar)
        }
        return out + "'"
    }

    /// tsvector text output, e.g. `'a':1 'b':2,3`.
    public static func formatTsvector(_ vector: TsVector) -> String {
        vector.sorted { SQLText.compareCodePoints($0.key, $1.key) < 0 }
            .map { "\(quoteLexeme($0.key)):\($0.value.map(String.init).joined(separator: ","))" }
            .joined(separator: " ")
    }

    // MARK: websearch_to_tsquery('simple', ...)

    public indirect enum TsQuery: Sendable, Equatable {
        case val(lexeme: String, id: Int)
        case not(TsQuery)
        case and(TsQuery, TsQuery)
        case or(TsQuery, TsQuery)
        case phrase(TsQuery, TsQuery, distance: Int)
    }

    /// A query under construction: `stop` marks an operand without lexemes.
    indirect enum Draft {
        case val(String)
        case stop
        case not(Draft)
        case and(Draft, Draft)
        case or(Draft, Draft)
        case phrase(Draft, Draft, distance: Int)
    }

    enum Op {
        case not, and, or, phrase

        var priority: Int {
            switch self {
            case .or: return 1
            case .and: return 2
            case .phrase: return 3
            case .not: return 4
            }
        }
    }

    /// tsquery.c ISOPERATOR.
    static func isQueryOperator(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return false }
        return c == "!" || c == "&" || c == "|" || c == "(" || c == ")" || c == "<"
    }

    static func isQuerySpace(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return false }
        return c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{0B}" || c == "\u{0C}"
    }

    static func isAsciiAlnum(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return false }
        return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
    }

    /// pushval_morph(): an operand's lexemes joined by `<->`, or a stop placeholder.
    static func operandDraft(_ text: String) -> Draft {
        var out: Draft?
        for word in lexemes(text) {
            let value = Draft.val(word.lexeme)
            out = out.map { .phrase($0, value, distance: 1) } ?? value
        }
        return out ?? .stop
    }

    struct QueryStackError: Error {}

    /// gettoken_query_websearch() plus makepol(): the query in tree form.
    static func parseWebsearch(_ query: String) throws -> Draft? {
        let s = Array(query.unicodeScalars)
        var i = 0
        var expectingOperand = true
        var first = true
        var output: [Draft] = []
        var stack: [Op] = []
        func at(_ index: Int) -> Unicode.Scalar? { index < s.count ? s[index] : nil }
        func emit(_ op: Op) throws {
            if op == .not {
                guard let arg = output.popLast() else { throw QueryStackError() }
                output.append(.not(arg))
                return
            }
            guard let right = output.popLast(), let left = output.popLast() else { throw QueryStackError() }
            switch op {
            case .phrase: output.append(.phrase(left, right, distance: 1))
            case .and: output.append(.and(left, right))
            default: output.append(.or(left, right))
            }
        }
        func pushOperator(_ op: Op) throws {
            while let top = stack.last {
                if (op != .not && op.priority > top.priority) || (op == .not && op.priority >= top.priority) { break }
                stack.removeLast()
                try emit(top)
            }
            stack.append(op)
        }
        /// parse_or_operator().
        func isOr() -> Bool {
            guard let o = at(i), o == "o" || o == "O", let r = at(i + 1), r == "r" || r == "R" else { return false }
            var j = i + 2
            guard let after = at(j) else { return false }
            if after == "-" || after == "_" || isAsciiAlnum(after) { return false }
            while true {
                j += 1
                if j >= s.count { return false }
                if !isQuerySpace(s[j]) { break }
            }
            i += 2
            return true
        }
        while true {
            if expectingOperand {
                let c = at(i)
                if c == "-" {
                    i += 1
                    first = false
                    try pushOperator(.not)
                    continue
                }
                if c == "\"" {
                    i += 1
                    let start = i
                    while i < s.count, s[i] != "\"" { i += 1 }
                    let text = String(String.UnicodeScalarView(s[start..<i]))
                    if i < s.count { i += 1 }
                    output.append(operandDraft(text))
                    expectingOperand = false
                    continue
                }
                if isQueryOperator(c) {
                    i += 1
                    first = false
                    continue
                }
                guard let c else {
                    if !first { output.append(.stop) }
                    break
                }
                if !isQuerySpace(c) {
                    // gettoken_tsvector in websearch mode: a word up to a space, an operator, a quote or a colon.
                    let start = i
                    i += 1
                    while i < s.count, !isQuerySpace(s[i]), !isQueryOperator(s[i]), s[i] != "\"", s[i] != ":" { i += 1 }
                    output.append(operandDraft(String(String.UnicodeScalarView(s[start..<i]))))
                    expectingOperand = false
                    continue
                }
                i += 1
            } else {
                guard let c = at(i) else { break }
                if isOr() {
                    expectingOperand = true
                    first = false
                    try pushOperator(.or)
                    continue
                }
                if isQueryOperator(c) {
                    i += 1
                    continue
                }
                if !isQuerySpace(c) {
                    expectingOperand = true
                    first = false
                    try pushOperator(.and)
                    continue
                }
                i += 1
            }
        }
        while let op = stack.popLast() { try emit(op) }
        if output.isEmpty { return nil }
        guard output.count == 1 else { throw QueryStackError() }
        return output[0]
    }

    /// clean_stopword_intree(): drop operands without lexemes, widening phrase distances.
    static func removeStops(_ node: Draft) -> (node: Draft?, ladd: Int, radd: Int) {
        switch node {
        case .val: return (node, 0, 0)
        case .stop: return (nil, 0, 0)
        case .not(let arg):
            let r = removeStops(arg)
            return (r.node.map { Draft.not($0) }, r.ladd, r.radd)
        case .and(let left, let right), .or(let left, let right), .phrase(let left, let right, _):
            let l = removeStops(left)
            let r = removeStops(right)
            var distance = 0
            var isPhrase = false
            if case .phrase(_, _, let d) = node {
                distance = d
                isPhrase = true
            }
            guard let ln = l.node else {
                if r.node == nil {
                    let add = isPhrase ? l.ladd + distance + r.ladd : max(l.ladd, r.ladd)
                    return (nil, add, add)
                }
                return isPhrase ? (r.node, l.ladd + distance + r.ladd, r.radd) : (r.node, r.ladd, r.radd)
            }
            guard let rn = r.node else {
                return isPhrase ? (ln, l.ladd, l.radd + distance + r.radd) : (ln, l.ladd, l.radd)
            }
            switch node {
            case .phrase: return (.phrase(ln, rn, distance: distance + l.radd + r.ladd), l.ladd, r.radd)
            case .and: return (.and(ln, rn), 0, 0)
            default: return (.or(ln, rn), 0, 0)
            }
        }
    }

    static func freeze(_ node: Draft, _ next: inout Int) -> TsQuery {
        switch node {
        case .val(let lexeme):
            defer { next += 1 }
            return .val(lexeme: lexeme, id: next)
        // removeStops leaves no placeholder.
        case .stop: return .val(lexeme: "", id: -1)
        case .not(let arg): return .not(freeze(arg, &next))
        case .phrase(let l, let r, let distance):
            let left = freeze(l, &next)
            return .phrase(left, freeze(r, &next), distance: distance)
        case .and(let l, let r):
            let left = freeze(l, &next)
            return .and(left, freeze(r, &next))
        case .or(let l, let r):
            let left = freeze(l, &next)
            return .or(left, freeze(r, &next))
        }
    }

    /// websearch_to_tsquery('simple', query); nil is the empty query, which matches nothing.
    public static func websearchToTsquery(_ query: String) throws -> TsQuery? {
        guard let draft = try parseWebsearch(query), let cleaned = removeStops(draft).node else { return nil }
        var next = 0
        return freeze(cleaned, &next)
    }

    /// tsquery text output (tsquery.c infix()).
    public static func formatTsquery(_ query: TsQuery?) -> String {
        guard let query else { return "" }
        func render(_ node: TsQuery, _ parentPriority: Int, _ rightPhrase: Bool) -> String {
            let parts: (left: TsQuery, right: TsQuery, op: Op, symbol: String)
            switch node {
            case .val(let lexeme, _): return quoteLexeme(lexeme)
            case .not(let arg):
                let inner = "!" + render(arg, Op.not.priority, false)
                return Op.not.priority < parentPriority ? "( \(inner) )" : inner
            case .and(let l, let r): parts = (l, r, .and, "&")
            case .or(let l, let r): parts = (l, r, .or, "|")
            case .phrase(let l, let r, let distance): parts = (l, r, .phrase, distance == 1 ? "<->" : "<\(distance)>")
            }
            let (left, right, op, symbol) = parts
            let rightText = render(right, op.priority, op == .phrase)
            let leftText = render(left, op.priority, false)
            let text = "\(leftText) \(symbol) \(rightText)"
            return op.priority < parentPriority || (op == .phrase && rightPhrase) ? "( \(text) )" : text
        }
        return render(query, -1, false)
    }

    // MARK: @@ and ts_rank_cd

    /// ExecPhraseData: match positions, width, and whether they are negated.
    final class PhraseData {
        var pos: [Int] = []
        var width = 0
        var negate = false
    }

    typealias Operand = (_ lexeme: String, _ id: Int) -> [Int]?

    static let emitLeftOnly = 1
    static let emitRightOnly = 2
    static let emitBoth = 4

    /// TS_phrase_output(): merge two position lists.
    @discardableResult
    static func phraseOutput(
        _ data: PhraseData?, _ l: PhraseData, _ r: PhraseData, _ emit: Int, _ lOffset: Int, _ rOffset: Int
    ) -> Bool {
        var li = 0
        var ri = 0
        var any = false
        while li < l.pos.count || ri < r.pos.count {
            let lpos: Int
            let rpos: Int
            var output = 0
            if li < l.pos.count {
                lpos = l.pos[li] + lOffset
            } else {
                if emit & emitRightOnly == 0 { break }
                lpos = Int.max
            }
            if ri < r.pos.count {
                rpos = r.pos[ri] + rOffset
            } else {
                if emit & emitLeftOnly == 0 { break }
                rpos = Int.max
            }
            if lpos < rpos {
                if emit & emitLeftOnly != 0 { output = lpos }
                li += 1
            } else if lpos == rpos {
                if emit & emitBoth != 0 { output = rpos }
                li += 1
                ri += 1
            } else {
                if emit & emitRightOnly != 0 { output = rpos }
                ri += 1
            }
            if output > 0 {
                guard let data else { return true }
                data.pos.append(output)
                any = true
            }
        }
        return any
    }

    /// TS_phrase_execute() (no MAYBE results: every operand has positions).
    static func phraseExecute(_ node: TsQuery, _ operand: Operand, _ data: PhraseData?) -> Bool {
        switch node {
        case .val(let lexeme, let id):
            guard let pos = operand(lexeme, id) else { return false }
            data?.pos = pos
            return true
        case .not(let arg):
            let target = data ?? PhraseData()
            if !phraseExecute(arg, operand, target) {
                target.negate = true
                return true
            }
            if !target.pos.isEmpty {
                target.negate.toggle()
                return true
            }
            if target.negate {
                target.negate = false
                return false
            }
            return false
        case .phrase(let left, let right, _), .and(let left, let right):
            let l = PhraseData()
            let r = PhraseData()
            if !phraseExecute(left, operand, l) { return false }
            if !phraseExecute(right, operand, r) { return false }
            let lOffset: Int
            let rOffset: Int
            if case .phrase(_, _, let distance) = node {
                lOffset = distance + r.width
                rOffset = 0
                data?.width = distance + l.width + r.width
            } else {
                let maxWidth = max(l.width, r.width)
                lOffset = maxWidth - l.width
                rOffset = maxWidth - r.width
                data?.width = maxWidth
            }
            if l.negate && r.negate {
                phraseOutput(data, l, r, emitBoth | emitLeftOnly | emitRightOnly, lOffset, rOffset)
                data?.negate = true
                return true
            }
            if l.negate { return phraseOutput(data, l, r, emitRightOnly, lOffset, rOffset) }
            if r.negate { return phraseOutput(data, l, r, emitLeftOnly, lOffset, rOffset) }
            return phraseOutput(data, l, r, emitBoth, lOffset, rOffset)
        case .or(let left, let right):
            let l = PhraseData()
            let r = PhraseData()
            let lmatch = phraseExecute(left, operand, l)
            let rmatch = phraseExecute(right, operand, r)
            if !lmatch && !rmatch { return false }
            if !lmatch { l.width = 0 }
            if !rmatch { r.width = 0 }
            let maxWidth = max(l.width, r.width)
            let lOffset = maxWidth - l.width
            let rOffset = maxWidth - r.width
            let target = data ?? PhraseData()
            target.width = maxWidth
            if l.negate && r.negate {
                phraseOutput(target, l, r, emitBoth, lOffset, rOffset)
                target.negate = true
                return true
            }
            if l.negate {
                phraseOutput(target, l, r, emitLeftOnly, lOffset, rOffset)
                target.negate = true
                return true
            }
            if r.negate {
                phraseOutput(target, l, r, emitRightOnly, lOffset, rOffset)
                target.negate = true
                return true
            }
            return phraseOutput(data, l, r, emitBoth | emitLeftOnly | emitRightOnly, lOffset, rOffset)
        }
    }

    /// TS_execute() with TS_EXEC_EMPTY.
    static func execute(_ node: TsQuery, _ operand: Operand) -> Bool {
        switch node {
        case .val(let lexeme, let id): return operand(lexeme, id) != nil
        case .not(let arg): return !execute(arg, operand)
        case .and(let l, let r): return execute(l, operand) && execute(r, operand)
        case .or(let l, let r): return execute(l, operand) || execute(r, operand)
        case .phrase: return phraseExecute(node, operand, nil)
        }
    }

    /// `vector @@ query`.
    public static func tsMatch(_ vector: TsVector, _ query: TsQuery?) -> Bool {
        guard let query else { return false }
        return execute(query) { lexeme, _ in vector[lexeme] }
    }

    static func operands(_ node: TsQuery, _ out: inout [(lexeme: String, id: Int)]) {
        switch node {
        case .val(let lexeme, let id): out.append((lexeme, id))
        case .not(let arg): operands(arg, &out)
        case .and(let l, let r), .or(let l, let r), .phrase(let l, let r, _):
            operands(l, &out)
            operands(r, &out)
        }
    }

    /// 1 / weight D (0.1 as float4), as calc_rank_cd() computes invws[0].
    static let inverseWeightD = 1 / Double(Float(0.1))

    /// ts_rank_cd(vector, query) with normalization 0 (tsrank.c calc_rank_cd and Cover), as
    /// the float4 PostgreSQL returns.
    public static func tsRankCd(_ vector: TsVector, _ query: TsQuery?) -> Double {
        guard let query else { return 0 }
        var items: [(lexeme: String, id: Int)] = []
        operands(query, &items)
        // get_docrep(): one entry per (position, lexeme), with the operands it satisfies.
        struct Key: Hashable {
            let pos: Int
            let lexeme: String
        }
        var order: [Key] = []
        var ids: [Key: [Int]] = [:]
        for item in items {
            guard let positions = vector[item.lexeme] else { continue }
            for pos in positions {
                let key = Key(pos: pos, lexeme: item.lexeme)
                if ids[key] == nil { order.append(key) }
                ids[key, default: []].append(item.id)
            }
        }
        if order.isEmpty { return 0 }
        let doc: [(pos: Int, ids: [Int])] =
            order.sorted { $0.pos != $1.pos ? $0.pos < $1.pos : SQLText.compareCodePoints($0.lexeme, $1.lexeme) < 0 }
            .map { ($0.pos, ids[$0] ?? []) }
        let len = doc.count

        // QueryRepresentation: positions seen per operand during a scan.
        var seen: [Int: [Int]] = [:]
        var reverse = false
        func fill(_ entry: (pos: Int, ids: [Int])) {
            for id in entry.ids {
                guard var list = seen[id] else {
                    seen[id] = [entry.pos]
                    continue
                }
                if reverse ? list.first != entry.pos : list.last != entry.pos {
                    if reverse { list.insert(entry.pos, at: 0) } else { list.append(entry.pos) }
                    seen[id] = list
                }
            }
        }
        func satisfied() -> Bool { execute(query) { _, id in seen[id] } }

        var extPos = 0
        var wdoc = 0.0
        /// Cover(): the next minimal extent [begin, end] satisfying the query.
        func cover() -> (begin: Int, end: Int, p: Int, q: Int)? {
            while true {
                var lastpos = extPos
                var found = false
                seen = [:]
                reverse = false
                var p = Int.max
                var q = 0
                var end = -1
                var begin = -1
                var k = extPos
                while k < len {
                    fill(doc[k])
                    if satisfied() {
                        if doc[k].pos > q {
                            q = doc[k].pos
                            end = k
                            lastpos = k
                            found = true
                        }
                        break
                    }
                    k += 1
                }
                if !found { return nil }
                seen = [:]
                reverse = true
                k = lastpos
                while k >= extPos {
                    fill(doc[k])
                    if satisfied() {
                        if doc[k].pos < p {
                            begin = k
                            p = doc[k].pos
                        }
                        break
                    }
                    k -= 1
                }
                if p <= q {
                    extPos = k + 1
                    return (begin, end, p, q)
                }
                extPos += 1
            }
        }
        while let ext = cover() {
            var inverseSum = 0.0
            for _ in ext.begin...ext.end { inverseSum += inverseWeightD }
            let cpos = Double(ext.end - ext.begin + 1) / inverseSum
            var noise = ext.q - ext.p - (ext.end - ext.begin)
            if noise < 0 { noise = (ext.end - ext.begin) / 2 }
            wdoc += cpos / Double(1 + noise)
        }
        return SQLText.float4Value(wdoc)
    }

    // MARK: SQL entry points

    /// `to_tsvector('simple', document) @@ websearch_to_tsquery('simple', query)`.
    public static func match(_ document: String, _ query: String) throws -> Bool {
        guard let parsed = try QueryCache.shared.query(query) else { return false }
        return tsMatch(toTsvector(document), parsed)
    }

    /// `ts_rank_cd(to_tsvector('simple', document), websearch_to_tsquery('simple', query))`.
    public static func rank(_ document: String, _ query: String) throws -> Double {
        guard let parsed = try QueryCache.shared.query(query) else { return 0 }
        return tsRankCd(toTsvector(document), parsed)
    }
}

/// Parsed queries, cleared when the cache grows past 500 like the original.
// lint:allow unchecked-sendable every access holds the lock
private final class QueryCache: @unchecked Sendable {
    static let shared = QueryCache()
    private let lock = NSLock()
    private var entries: [String: SQLFullText.TsQuery?] = [:]

    func query(_ text: String) throws -> SQLFullText.TsQuery? {
        if let cached = lock.withLock({ entries[text] }) { return cached }
        let parsed = try SQLFullText.websearchToTsquery(text)
        lock.withLock {
            if entries.count > 500 { entries.removeAll() }
            entries[text] = .some(parsed)
        }
        return parsed
    }
}
