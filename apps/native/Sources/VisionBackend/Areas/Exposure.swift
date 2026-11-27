import CryptoKit
import Foundation
import VisionNativeCore

/// `routes/investments.ts` (the exposure block), `services/portfolio/portfolioExposureService`
/// and `repositories/portfolioExposureRepository.ts`: the look-through aggregate
/// (`getPortfolioExposure`), the classification bundle upsert
/// (`upsertPortfolioExposureSources`, ADR-267 — manual edits win over imports), the
/// classifiable list and the hand-set/clear writes
/// (`getPortfolioExposureClassifications`, `savePortfolioExposureClassifications`). The
/// summary each read consumes comes from `PortfolioSummaryService`; `getInvestment` registers
/// with this area because its `/:id` template may only match once the fixed `/exposure`
/// routes are served.
enum ExposureArea {
    static let identifierTypes = ["isin", "ticker", "sedol", "cusip", "lei", "proprietary"]
    static let manualSourceLabel = "Set in Vision"

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetPortfolioExposure.self) { request in
            let currency = try currencyQuery(request)
            return try await database.run { session in
                let summary = try PortfolioSummaryService.summary(session, target: currency)
                let stored = try sources(session)
                return HandlerResult(data: .object(try aggregate(summary, stored)))
            }
        }
        backend.serve(OpenAPIOperations.UpsertPortfolioExposureSources.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            let bundle = try bundleBody(body)
            return try await database.run { session in
                try upsert(session, bundle)
            }
        }
        backend.serve(OpenAPIOperations.GetPortfolioExposureClassifications.self) { _ in
            try await database.run { session in
                HandlerResult(data: .object(try classifications(session)))
            }
        }
        backend.serve(OpenAPIOperations.SavePortfolioExposureClassifications.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            let changes = try changesBody(body)
            return try await database.run { session in
                try save(session, changes)
            }
        }
        // Router order: `/exposure*` above, then `/:id` (`investmentService.getInvestment`).
        backend.serve(OpenAPIOperations.GetInvestment.self) { request in
            let id = try InvestmentsArea.pathId(request)
            return try await database.run { session in
                let rows = try session.rows(
                    """
                    SELECT i.*, COALESCE(tp.show_in_ticker, 1) AS show_in_ticker \
                    FROM investments i LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id \
                    WHERE i.id = ?
                    """, [.integer(Int64(id.rawValue))])
                guard let row = rows.first else {
                    throw BackendHTTPError.notFound("Investment not found")
                }
                return HandlerResult(data: .object(try InvestmentsArea.investmentJson(row)))
            }
        }
    }

    // MARK: - Request input

    /// `exposureQuery`: `looseText(raw || "EUR")` uppercased, then the ISO-4217 regex.
    static func currencyQuery(_ request: InProcessRequest) throws -> String {
        let raw = request.query("currency") ?? ""
        let upper = JavaScriptCase.uppercased(raw.isEmpty ? "EUR" : raw)
        guard AccountsArea.isCurrencyCode(upper) else {
            throw BackendHTTPError.validation("currency: must be an ISO 4217 code")
        }
        return upper
    }

    /// zod 4's issue object, in the order the schema's checks run.
    struct Issue: Sendable {
        var code: String
        var path: [Either] = []
        var message: String
        var keys: [String]? = nil

        /// One path element: a key or an array index.
        enum Either: Sendable {
            case key(String)
            case index(Int)

            var value: JSONValue {
                switch self {
                case .key(let text): return .string(text)
                case .index(let number): return .int(number)
                }
            }
        }

        var json: JSONValue {
            var fields: [String: JSONValue] = [
                "code": .string(code),
                "path": .array(path.map { $0.value }),
                "message": .string(message),
            ]
            if let keys { fields["keys"] = .array(keys.map { .string($0) }) }
            return .object(fields)
        }
    }

    /// `invalidSource(message, issues)`: the 400 the exposure routes answer.
    static func invalidSource(_ message: String, _ issues: [Issue]) -> BackendHTTPError {
        BackendHTTPError(
            status: 400, code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE", message: message,
            details: issues.isEmpty
                ? .object([:]) : .object(["issues": .array(issues.map { $0.json })]))
    }

    /// The fields of the classification / identifier / manual schemas, trimmed as zod trims.
    struct ClassificationInput: Sendable {
        var investmentId: Int? = nil  // lint:allow raw-id the bundle's investment target
        var identifier: (type: String, value: String, exchange: String?)? = nil
        var issuerId: String  // lint:allow raw-id an external issuer key, not a table id
        var issuerName: String
        var sector: String? = nil
        var issuerCountryCode: String? = nil
        var sourceLabel: String = ""
        var fundDocument = false
        var document: JSValue? = nil
        var shareClassIdentifier: (type: String, value: String, exchange: String?)? = nil

        /// `identifierKey` of the stored or supplied identifier columns.
        var identifierKey: String {
            guard let identifier else { return "" }
            return "\(identifier.type):\(identifier.exchange ?? ""):\(identifier.value)"
        }
    }

    struct ChangesInput: Sendable {
        var set: [(investmentId: Int, issuerName: String, sector: String?, country: String?)] = []  // lint:allow raw-id the request's investment targets
        var clear: [Int] = []  // lint:allow raw-id the request's investment targets
    }

    // MARK: Field checks (zod 4 issue vocabulary)

    /// `z.string().trim().min(1).max(limit)`: trimmed, non-empty, bounded.
    private static func trimmedString(
        _ value: JSValue?, at path: [Issue.Either], issues: inout [Issue], limit: Int
    ) -> String? {
        guard let value else { return nil }
        guard case .string(let raw) = value else {
            issues.append(
                Issue(code: "invalid_type", path: path, message: "Invalid input: expected string, received \(value.zodTypeName)"))
            return nil
        }
        let trimmed = JavaScriptWhitespace.trim(raw)
        if trimmed.isEmpty {
            issues.append(
                Issue(code: "too_small", path: path, message: "Too small: expected string to have at least 1 characters"))
            return nil
        }
        if trimmed.utf16.count > limit {
            issues.append(
                Issue(code: "too_big", path: path, message: "Too big: expected string to have at most \(limit) characters"))
            return nil
        }
        return trimmed
    }

    /// `z.number().int().positive()`, optional.
    private static func positiveInt(
        _ value: JSValue?, at path: [Issue.Either], issues: inout [Issue], optional: Bool
    ) -> Int? {
        guard let value else {
            if optional { return nil }
            issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected number, received undefined"))
            return nil
        }
        guard case .number(let number) = value, number.rounded(.towardZero) == number, number > 0,
            let id = Int(exactly: number)
        else {
            issues.append(
                Issue(code: "custom", path: path, message: "Invalid input: expected number, received \(value.zodTypeName)"))
            return nil
        }
        return id
    }

    /// `identifier` (the strict identifier schema with its `superRefine`).
    private static func identifier(
        _ value: JSValue?, at path: [Issue.Either], issues: inout [Issue]
    ) -> (type: String, value: String, exchange: String?)? {
        guard let value else { return nil }
        guard let fields = value.objectValue else {
            issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected object, received \(value.zodTypeName)"))
            return nil
        }
        let unknown = fields.keys.filter { !["type", "value", "exchange"].contains($0) }
        if !unknown.isEmpty {
            issues.append(
                Issue(
                    code: "unrecognized_keys", path: path,
                    message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
        }
        guard let type = trimmedString(fields["type"], at: path + [.key("type")], issues: &issues, limit: 64) else {
            return nil
        }
        if !identifierTypes.contains(type) {
            issues.append(
                Issue(
                    code: "invalid_enum_value", path: path,
                    message: "Invalid input: expected \(identifierTypes.map { "\"\($0)\"" }.joined(separator: ", ")), received \"\(type)\""))
            return nil
        }
        guard let text = trimmedString(fields["value"], at: path + [.key("value")], issues: &issues, limit: 128) else {
            return nil
        }
        if type != "ticker", let exchange = fields["exchange"], exchange != .null {
            issues.append(
                Issue(
                    code: "custom", path: path + [.key("exchange")],
                    message: "Only ticker identifiers may declare an exchange"))
            return nil
        }
        var exchange: String? = nil
        if type == "ticker", let raw = fields["exchange"], raw != .null {  // lint:allow string-literal-compare the schema's identifier enum
            guard let text = trimmedString(raw, at: path + [.key("exchange")], issues: &issues, limit: 64) else {
                return nil
            }
            exchange = text
        }
        if type == "isin", !isCanonicalISIN(text) {  // lint:allow string-literal-compare the schema's identifier enum
            issues.append(
                Issue(
                    code: "custom", path: path + [.key("value")],
                    message: "ISIN must use its 12-character canonical form"))
            return nil
        }
        return (type, text, exchange)
    }

    /// `z.string().regex(/^[A-Z]{2}$/)`.
    static func isCountryCode(_ text: String) -> Bool {
        text.utf8.count == 2 && text.utf8.allSatisfy { (65...90).contains($0) }
    }

    /// `/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/` of the ISIN check.
    static func isCanonicalISIN(_ text: String) -> Bool {
        let units = Array(text.utf16)
        guard units.count == 12 else { return false }
        let a = units[0], b = units[1]
        guard (65...90).contains(Int(a)), (65...90).contains(Int(b)) else { return false }
        for unit in units[2..<11] {
            let value = Int(unit)
            guard (65...90).contains(value) || (48...57).contains(value) else { return false }
        }
        return (48...57).contains(Int(units[11]))
    }

    /// `replace(/\s+/g, " ")` over the schema's trim: every whitespace run one
    /// space (JS `\s`: WhiteSpace and LineTerminator).
    static func collapseWhitespace(_ text: String) -> String {
        var collapsed = ""
        var previousWasSpace = false
        for scalar in text.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !previousWasSpace { collapsed.append(" ") }
                previousWasSpace = true
            } else {
                collapsed.append(Character(scalar))
                previousWasSpace = false
            }
        }
        return collapsed
    }
}

// MARK: - Bundle and changes bodies

extension ExposureArea {
    /// `portfolioExposureBundleSchema.safeParse` + the service's duplicate/attachment checks
    /// (the order `upsertPortfolioExposureBundle` runs them in).
    static func bundleBody(_ body: JSValue?) throws -> (classifications: [ClassificationInput], fundDocuments: [ClassificationInput]) {
        var issues: [Issue] = []
        guard let root = body?.objectValue else {
            throw invalidSource(
                "The exposure source bundle is invalid",
                [Issue(code: "invalid_type", message: "Invalid input: expected object, received \(body?.zodTypeName ?? "undefined")")])
        }
        // strictObject: the declared keys only.
        let unknown = root.keys.filter { !["classifications", "fundDocuments"].contains($0) }
        if !unknown.isEmpty {
            issues.append(
                Issue(
                    code: "unrecognized_keys",
                    message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
        }
        guard case .array(let rawClassifications)? = root["classifications"] else {
            issues.append(
                Issue(
                    code: "invalid_type", path: [.key("classifications")],
                    message: "Invalid input: expected array, received \(root["classifications"]?.zodTypeName ?? "undefined")"))
            throw invalidSource("The exposure source bundle is invalid", issues)
        }
        guard case .array(let rawDocuments)? = root["fundDocuments"] else {
            issues.append(
                Issue(
                    code: "invalid_type", path: [.key("fundDocuments")],
                    message: "Invalid input: expected array, received \(root["fundDocuments"]?.zodTypeName ?? "undefined")"))
            throw invalidSource("The exposure source bundle is invalid", issues)
        }

        // `z.array(...).max(n)`: an oversized array fails before its elements are parsed.
        if rawClassifications.count > 5_000 {
            issues.append(Issue(
                code: "too_big", path: [.key("classifications")],
                message: "Too big: expected array to have <=5000 items"))
        }
        if rawDocuments.count > 500 {
            issues.append(Issue(
                code: "too_big", path: [.key("fundDocuments")], message: "Too big: expected array to have <=500 items"))
        }
        guard issues.isEmpty else { throw invalidSource("The exposure source bundle is invalid", issues) }
        var classifications: [ClassificationInput] = []
        for (index, raw) in rawClassifications.enumerated() {
            let path: [Issue.Either] = [.key("classifications"), .index(index)]
            guard let input = classification(raw, at: path, issues: &issues) else { continue }
            classifications.append(input)
        }
        var fundDocuments: [ClassificationInput] = []
        for (index, raw) in rawDocuments.enumerated() {
            let path: [Issue.Either] = [.key("fundDocuments"), .index(index)]
            guard let input = documentInput(raw, at: path, issues: &issues) else { continue }
            fundDocuments.append(input)
        }
        guard issues.isEmpty else { throw invalidSource("The exposure source bundle is invalid", issues) }
        return (classifications, fundDocuments)
    }

    /// One `classification` element: the strict schema and its exactly-one-target refine.
    static func classification(_ value: JSValue?, at path: [Issue.Either], issues: inout [Issue]) -> ClassificationInput? {
        guard let fields = value?.objectValue else {
            issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected object, received \(value?.zodTypeName ?? "undefined")"))
            return nil
        }
        let unknown = fields.keys.filter {
            !["investmentId", "identifier", "issuerId", "issuerName", "sector", "issuerCountryCode", "sourceLabel"].contains($0)
        }
        if !unknown.isEmpty {
            issues.append(Issue(code: "unrecognized_keys", path: path, message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
        }
        let issuesBeforeFields = issues.count
        let investmentId = positiveInt(fields["investmentId"], at: path + [.key("investmentId")], issues: &issues, optional: true)
        let identifier = identifier(fields["identifier"], at: path + [.key("identifier")], issues: &issues)
        guard let issuerId = trimmedNoDefault(fields["issuerId"], at: path + [.key("issuerId")], issues: &issues, limit: 128),
            let issuerName = trimmedNoDefault(fields["issuerName"], at: path + [.key("issuerName")], issues: &issues, limit: 256),
            let sourceLabel = trimmedNoDefault(fields["sourceLabel"], at: path + [.key("sourceLabel")], issues: &issues, limit: 300)
        else { return nil }
        var sector: String? = nil
        if let raw = fields["sector"], raw != .null {
            guard let text = trimmedNoDefault(raw, at: path + [.key("sector")], issues: &issues, limit: 128) else { return nil }
            sector = text
        }
        var country: String? = nil
        if let raw = fields["issuerCountryCode"], raw != .null {
            guard case .string(let code) = raw, isCountryCode(code) else {
                issues.append(Issue(code: "custom", path: path + [.key("issuerCountryCode")], message: "Invalid"))
                return nil
            }
            country = code
        }
        // zod runs the element's `.refine` only when the strict object itself parsed clean,
        // so a field issue must not also answer the exactly-one-target check.
        guard issues.count == issuesBeforeFields else { return nil }
        let hasId = investmentId != nil
        let hasIdentifier = identifier != nil
        if hasId == hasIdentifier {
            issues.append(
                Issue(
                    code: "custom", path: path,
                    message: "Classification must target exactly one investment or typed identifier"))
            return nil
        }
        if let investmentId, investmentId <= 0 {
            return nil
        }
        return ClassificationInput(
            investmentId: investmentId, identifier: identifier, issuerId: issuerId, issuerName: issuerName,
            sector: sector, issuerCountryCode: country, sourceLabel: sourceLabel)
    }

    /// A required trimmed string of the schema.
    private static func trimmedNoDefault(
        _ value: JSValue?, at path: [Issue.Either], issues: inout [Issue], limit: Int
    ) -> String? {
        guard let value, value != .null else {
            issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected string, received \(value?.zodTypeName ?? "undefined")"))
            return nil
        }
        return trimmedString(value, at: path, issues: &issues, limit: limit)
    }

    /// One `documentInput`: the investment, the share-class identifier and the fund document.
    static func documentInput(_ value: JSValue?, at path: [Issue.Either], issues: inout [Issue]) -> ClassificationInput? {
        guard let fields = value?.objectValue else {
            issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected object, received \(value?.zodTypeName ?? "undefined")"))
            return nil
        }
        let unknown = fields.keys.filter { !["investmentId", "shareClassIdentifier", "document"].contains($0) }
        if !unknown.isEmpty {
            issues.append(Issue(code: "unrecognized_keys", path: path, message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
        }
        // Every field is checked, so a missing share class or document is an issue (failing the
        // whole bundle) instead of an entry dropped from an otherwise successful import.
        let investmentId = positiveInt(fields["investmentId"], at: path + [.key("investmentId")], issues: &issues, optional: false)
        let shareClassPath = path + [.key("shareClassIdentifier")]
        if fields["shareClassIdentifier"] == nil {
            issues.append(Issue(code: "invalid_type", path: shareClassPath, message: "Invalid input: expected object, received undefined"))
        }
        let shareClassIdentifier = identifier(fields["shareClassIdentifier"], at: shareClassPath, issues: &issues)
        // `fundHoldingsDocumentSchema`: the holdings, weights, coverage, dates, provenance and
        // staleness must be consistent before the document can back reported exposure.
        let documentIssues = FundHoldingsContract.validate(fields["document"], at: path + [.key("document")])
        issues += documentIssues
        guard let investmentId, let shareClassIdentifier, let document = fields["document"], documentIssues.isEmpty
        else { return nil }
        var input = ClassificationInput(investmentId: investmentId, issuerId: "", issuerName: "")
        input.fundDocument = true
        input.document = document
        input.shareClassIdentifier = shareClassIdentifier
        return input
    }

    /// `manualClassificationChangesSchema.safeParse`.
    static func changesBody(_ body: JSValue?) throws -> ChangesInput {
        var issues: [Issue] = []
        guard let root = body?.objectValue else {
            throw invalidSource(
                "The classification changes are invalid",
                [Issue(code: "invalid_type", message: "Invalid input: expected object, received \(body?.zodTypeName ?? "undefined")")])
        }
        let unknown = root.keys.filter { !["set", "clear"].contains($0) }
        if !unknown.isEmpty {
            issues.append(Issue(code: "unrecognized_keys", message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
        }
        var changes = ChangesInput()
        let rawSet: [JSValue]
        if case .array(let items) = root["set"] {
            rawSet = items
        } else if root["set"] == nil || root["set"] == .null {
            rawSet = []
        } else {
            issues.append(Issue(code: "invalid_type", path: [.key("set")], message: "Invalid input: expected array, received \((root["set"] ?? .null).zodTypeName)"))
            throw invalidSource("The classification changes are invalid", issues)
        }
        let rawClear: [JSValue]
        if case .array(let items) = root["clear"] {
            rawClear = items
        } else if root["clear"] == nil || root["clear"] == .null {
            rawClear = []
        } else {
            issues.append(Issue(code: "invalid_type", path: [.key("clear")], message: "Invalid input: expected array, received \((root["clear"] ?? .null).zodTypeName)"))
            throw invalidSource("The classification changes are invalid", issues)
        }
        if rawSet.count > 5_000 {
            issues.append(Issue(code: "too_big", path: [.key("set")], message: "Too big: expected array to have <=5000 items"))
        }
        if rawClear.count > 5_000 {
            issues.append(Issue(code: "too_big", path: [.key("clear")], message: "Too big: expected array to have <=5000 items"))
        }
        guard issues.isEmpty else { throw invalidSource("The classification changes are invalid", issues) }
        for (index, raw) in rawSet.enumerated() {
            let path: [Issue.Either] = [.key("set"), .index(index)]
            guard let fields = raw.objectValue else {
                issues.append(Issue(code: "invalid_type", path: path, message: "Invalid input: expected object, received \(raw.zodTypeName)"))
                continue
            }
            let unknown = fields.keys.filter { !["investmentId", "issuerName", "sector", "issuerCountryCode"].contains($0) }
            if !unknown.isEmpty {
                issues.append(Issue(code: "unrecognized_keys", path: path, message: "Unrecognized key: \"\(unknown.first ?? "")\"", keys: unknown))
            }
            guard let investmentId = positiveInt(fields["investmentId"], at: path + [.key("investmentId")], issues: &issues, optional: false),
                let issuerName = trimmedNoDefault(fields["issuerName"], at: path + [.key("issuerName")], issues: &issues, limit: 256)
            else { continue }
            var sector: String? = nil
            if let raw = fields["sector"], raw != .null {
                guard let text = trimmedNoDefault(raw, at: path + [.key("sector")], issues: &issues, limit: 128) else { continue }
                sector = text
            }
            var country: String? = nil
            if let raw = fields["issuerCountryCode"], raw != .null {
                guard case .string(let code) = raw, isCountryCode(code) else {
                    issues.append(Issue(code: "custom", path: path + [.key("issuerCountryCode")], message: "Invalid"))
                    continue
                }
                country = code
            }
            changes.set.append((investmentId, issuerName, sector, country))
        }
        for raw in rawClear {
            guard let id = positiveInt(raw, at: [], issues: &issues, optional: false) else { continue }
            changes.clear.append(id)
        }
        // `superRefine`'s duplicate check, over the set ids then the clear ids.
        var seen: Set<Int> = []
        for id in changes.set.map({ $0.investmentId }) + changes.clear where !seen.insert(id).inserted {
            issues.append(Issue(code: "custom", message: "Each investment may appear only once per request"))
            break
        }
        guard issues.isEmpty else { throw invalidSource("The classification changes are invalid", issues) }
        return changes
    }
}

// MARK: - The repository (`portfolioExposureRepository.ts`)

/// One stored classification row (`ExposureClassificationRow`).
struct ExposureClassification: Sendable {
    var id: String
    var investmentId: Int?  // lint:allow raw-id the row's investment target
    var identifierType: String?
    var identifierValue: String?
    var identifierExchange: String?
    var issuerId: String  // lint:allow raw-id an external issuer key, not a table id
    var issuerName: String
    var sector: String?
    var issuerCountryCode: String?
    var sourceLabel: String
    var origin: String
    var createdAt: Instant
    var updatedAt: Instant

    init(_ row: SQLRow) throws {
        id = try row.text("id")
        investmentId = try row.optionalInt64("investmentId").flatMap { Int(exactly: $0) }
        identifierType = try row.optionalText("identifierType").flatMap { $0.isEmpty ? nil : $0 }
        identifierValue = try row.optionalText("identifierValue").flatMap { $0.isEmpty ? nil : $0 }
        identifierExchange = try row.optionalText("identifierExchange").flatMap { $0.isEmpty ? nil : $0 }
        issuerId = try row.text("issuerId")
        issuerName = try row.text("issuerName")
        sector = try row.optionalText("sector").flatMap { $0.isEmpty ? nil : $0 }
        issuerCountryCode = try row.optionalText("issuerCountryCode").flatMap { $0.isEmpty ? nil : $0 }
        sourceLabel = try row.text("sourceLabel")
        origin = try row.text("origin")
        createdAt = try row.instant("createdAt")
        updatedAt = try row.instant("updatedAt")
    }

    /// The stored identifier's `identifierKey` (three null-ish parts read as "").
    var identifierKey: String {
        let type = identifierType ?? ""
        guard !type.isEmpty else { return "" }
        return "\(type):\(identifierExchange ?? ""):\(identifierValue ?? "")"
    }

    /// `res.json`'s row, in the checked row schema's column order.
    var json: JSObject {
        JSObject([
            ("id", .string(id)),
            ("investmentId", investmentId.map { JSValue.int($0) } ?? .null),
            ("identifierType", identifierType.map(JSValue.string) ?? .null),
            ("identifierValue", identifierValue.map(JSValue.string) ?? .null),
            ("identifierExchange", identifierExchange.map(JSValue.string) ?? .null),
            ("issuerId", .string(issuerId)),
            ("issuerName", .string(issuerName)),
            ("sector", sector.map(JSValue.string) ?? .null),
            ("issuerCountryCode", issuerCountryCode.map(JSValue.string) ?? .null),
            ("sourceLabel", .string(sourceLabel)),
            ("origin", .string(origin)),
            ("createdAt", .string(createdAt.text)),
            ("updatedAt", .string(updatedAt.text)),
        ])
    }
}

/// One stored fund-holdings document row.
struct ExposureDocument: Sendable {
    var id: String
    var investmentId: Int  // lint:allow raw-id the row's investment target
    var shareClassIdentifier: JSValue
    var document: JSValue
    var sourceAsOfDate: String
    var sourceSha256: String
    var createdAt: Instant
    var updatedAt: Instant

    init(_ row: SQLRow) throws {
        id = try row.text("id")
        investmentId = try row.integerId("investmentId")
        shareClassIdentifier = JSValue.parse(Data((try row.text("shareClassIdentifier")).utf8)) ?? .null
        document = JSValue.parse(Data((try row.text("document")).utf8)) ?? .null
        sourceAsOfDate = try row.text("sourceAsOfDate")
        sourceSha256 = try row.text("sourceSha256")
        createdAt = try row.instant("createdAt")
        updatedAt = try row.instant("updatedAt")
    }

    var json: JSObject {
        JSObject([
            ("id", .string(id)),
            ("investmentId", .int(investmentId)),
            ("shareClassIdentifier", shareClassIdentifier),
            ("document", document),
            // `dbDate`: the pg driver hands the route a UTC-midnight `Date`.
            ("sourceAsOfDate", .string("\(sourceAsOfDate)T00:00:00.000Z")),
            ("sourceSha256", .string(sourceSha256)),
            ("createdAt", .string(createdAt.text)),
            ("updatedAt", .string(updatedAt.text)),
        ])
    }
}

extension ExposureArea {
    /// `listExposureSources`: the classifications (issuer_name, id) and documents (investment_id).
    static func sources(_ session: BackendSession) throws -> (
        classifications: [ExposureClassification], documents: [ExposureDocument]
    ) {
        var classifications: [ExposureClassification] = []
        for row in try session.rows(
            """
            SELECT id, investment_id as investmentId, identifier_type as identifierType, \
            identifier_value as identifierValue, identifier_exchange as identifierExchange, \
            issuer_id as issuerId, issuer_name as issuerName, sector, \
            issuer_country_code as issuerCountryCode, source_label as sourceLabel, origin, \
            created_at as createdAt, updated_at as updatedAt \
            FROM portfolio_exposure_classifications ORDER BY issuer_name, id
            """)
        {
            classifications.append(try ExposureClassification(row))
        }
        var documents: [ExposureDocument] = []
        for row in try session.rows(
            """
            SELECT id, investment_id as investmentId, share_class_identifier_json as shareClassIdentifier, \
            document_json as document, source_as_of_date as sourceAsOfDate, source_sha256 as sourceSha256, \
            created_at as createdAt, updated_at as updatedAt \
            FROM portfolio_fund_holdings_documents ORDER BY investment_id
            """)
        {
            documents.append(try ExposureDocument(row))
        }
        return (classifications, documents)
    }

    /// `listExposureTargets`: the id and asset class of wanted investments.
    static func targets(_ session: BackendSession, _ ids: [Int]) throws -> [Int: String] {  // lint:allow raw-id as above
        guard !ids.isEmpty else { return [:] }
        let idsJSON = "[\(ids.map(String.init).joined(separator: ","))]"
        var out: [Int: String] = [:]
        for row in try session.rows(
            """
            SELECT id, asset_class as assetClass FROM investments \
            WHERE id IN (SELECT value FROM json_each(?))
            """, [.text(idsJSON)])
        {
            out[try row.integerId("id")] = try row.text("assetClass")
        }
        return out
    }

    /// `listManualClassificationIds`.
    static func manualClassificationIds(_ session: BackendSession, _ ids: [Int]) throws -> [Int] {  // lint:allow raw-id as above
        guard !ids.isEmpty else { return [] }
        let idsJSON = "[\(ids.map(String.init).joined(separator: ","))]"
        return try session.rows(
            """
            SELECT investment_id as id FROM portfolio_exposure_classifications \
            WHERE origin = 'manual' AND investment_id IN (SELECT value FROM json_each(?)) \
            ORDER BY investment_id
            """, [.text(idsJSON)]).compactMap { try? $0.integerId("id") }
    }

    /// `listClassifiableInvestments`: active holdings a user may classify, by (name, id).
    static func classifiableInvestments(_ session: BackendSession) throws -> [(
        id: Int, name: String, symbol: String?, assetClass: String
    )] {
        try session.rows(
            """
            SELECT id, name, symbol, asset_class as assetClass FROM investments \
            WHERE is_active = 1 ORDER BY name, id
            """).map { row in
                (try row.integerId("id"), try row.text("name"), try row.optionalText("symbol"),
                 try row.text("assetClass"))
            }
    }

    /// `upsertExposureBundle`'s transaction: every classification and document insert, with
    /// the origin-guard the imports respect (ADR-267).
    static func storeBundle(
        _ session: BackendSession, classifications: [ClassificationInput], documents: [ClassificationInput]
    ) throws {
        try session.transaction {
            for item in classifications {
                try session.rows(
                    """
                    INSERT INTO portfolio_exposure_classifications \
                    (investment_id, identifier_type, identifier_value, identifier_exchange, \
                    issuer_id, issuer_name, sector, issuer_country_code, source_label) \
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
                    ON CONFLICT\(item.investmentId != nil ? " (investment_id) WHERE investment_id IS NOT NULL" : " (identifier_type, identifier_value, COALESCE(identifier_exchange, '')) WHERE investment_id IS NULL") \
                    DO UPDATE SET issuer_id = excluded.issuer_id, issuer_name = excluded.issuer_name, \
                    sector = excluded.sector, issuer_country_code = excluded.issuer_country_code, \
                    source_label = excluded.source_label, updated_at = now() \
                    WHERE portfolio_exposure_classifications.origin = 'import'
                    """,
                    [
                        .integerOrNil(item.investmentId),
                        .textOrEmptyNil(item.identifier?.type),
                        .textOrEmptyNil(item.identifier?.value),
                        .textOrEmptyNil(item.identifier?.exchange),
                        .text(item.issuerId),
                        .text(item.issuerName),
                        .textOrEmptyNil(item.sector),
                        .textOrEmptyNil(item.issuerCountryCode),
                        .text(item.sourceLabel),
                    ])
            }
            for item in documents {
                let shareClassJSON = identifierJSON(item.shareClassIdentifier)
                try session.rows(
                    """
                    INSERT INTO portfolio_fund_holdings_documents \
                    (investment_id, share_class_identifier_json, document_json, source_as_of_date, \
                    source_sha256) VALUES (?, vision_jsonb(?), vision_jsonb(?), ?, ?) \
                    ON CONFLICT (investment_id) DO UPDATE SET \
                    share_class_identifier_json = excluded.share_class_identifier_json, \
                    document_json = excluded.document_json, \
                    source_as_of_date = excluded.source_as_of_date, \
                    source_sha256 = excluded.source_sha256, updated_at = now()
                    """,
                    [
                        .integer(Int64(item.investmentId ?? 0)),
                        .text(shareClassJSON),
                        .text(item.document?.jsonText ?? "null"),
                        .text(item.document?.objectValue?["source"]?["asOfDate"]?.stringValue ?? ""),
                        .text(sha256Hex(item.document?.jsonText ?? "null")),
                    ])
            }
        }
    }

    /// `saveManualClassifications`: the set rows (origin 'manual') and the clear deletions.
    static func storeManual(
        _ session: BackendSession,
        set: [(investmentId: Int, issuerId: String, issuerName: String, sector: String?, country: String?)],  // lint:allow raw-id the request's investment targets
        clear: [Int]
    ) throws {
        try session.transaction {
            for item in set {
                try session.rows(
                    """
                    INSERT INTO portfolio_exposure_classifications \
                    (investment_id, issuer_id, issuer_name, sector, issuer_country_code, \
                    source_label, origin) VALUES (?, ?, ?, ?, ?, ?, 'manual') \
                    ON CONFLICT (investment_id) WHERE investment_id IS NOT NULL DO UPDATE SET \
                    issuer_id = excluded.issuer_id, issuer_name = excluded.issuer_name, \
                    sector = excluded.sector, \
                    issuer_country_code = excluded.issuer_country_code, \
                    source_label = excluded.source_label, origin = excluded.origin, \
                    updated_at = now()
                    """,
                    [
                        .integer(Int64(item.investmentId)),
                        .text(item.issuerId),
                        .text(item.issuerName),
                        .textOrEmptyNil(item.sector),
                        .textOrEmptyNil(item.country),
                        .text(manualSourceLabel),
                    ])
            }
            if !clear.isEmpty {
                let idsJSON = "[\(clear.map(String.init).joined(separator: ","))]"
                _ = try session.rows(
                    """
                    DELETE FROM portfolio_exposure_classifications \
                    WHERE investment_id IN (SELECT value FROM json_each(?))
                    """, [.text(idsJSON)])
            }
        }
    }

    /// `JSON.stringify(shareClassIdentifier)`.
    private static func identifierJSON(_ identifier: (type: String, value: String, exchange: String?)?) -> String {
        guard let identifier else { return "null" }
        var object = JSObject([("type", .string(identifier.type)), ("value", .string(identifier.value))])
        if let exchange = identifier.exchange { object["exchange"] = .string(exchange) }
        return JSValue.object(object).jsonText
    }

    /// `createHash("sha256")` of the document's JSON text.
    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension SQLValue {
    /// An absent integer column (nil) and an absent text column ("" → NULL) as the driver sends them.
    static func integerOrNil(_ value: Int?) -> SQLValue { value.map { .integer(Int64($0)) } ?? .null }
    static func textOrEmptyNil(_ value: String?) -> SQLValue {
        guard let value, !value.isEmpty else { return .null }
        return .text(value)
    }
}

// MARK: - Service operations (`portfolioExposureService.ts`)

extension ExposureArea {
    /// `identifierKey` of a JSON identifier object (`type:exchange?:value`, nullish → "").
    static func key(_ identifier: JSValue) -> String {
        guard let fields = identifier.objectValue else { return "" }
        let type = fields["type"]?.stringValue ?? ""
        let value = fields["value"]?.stringValue ?? ""
        let exchange = fields["exchange"]?.stringValue ?? ""
        return "\(type):\(exchange):\(value)"
    }

    private static func bundleInvalid() -> BackendHTTPError {
        invalidSource("The exposure source bundle is invalid", [])
    }

    private static func changesInvalid() -> BackendHTTPError {
        invalidSource("The classification changes are invalid", [])
    }

    /// The stored state `res.ok(...)` answers with, plus the ADR-267 kept-manual report.
    private static func sourceObject(
        _ stored: (classifications: [ExposureClassification], documents: [ExposureDocument]),
        keptManualInvestmentIds: [Int]  // lint:allow raw-id the ids imports must not touch
    ) -> [String: JSONValue] {
        [
            "classifications": .array(stored.classifications.map { JSValue.object($0.json).envelopeValue }),
            "documents": .array(stored.documents.map { JSValue.object($0.json).envelopeValue }),
            "keptManualInvestmentIds": .array(keptManualInvestmentIds.map { .int($0) }),
        ]
    }

    /// `upsertPortfolioExposureBundle`: the service checks in their order, then the
    /// transaction and the stored-state answer.
    static func upsert(
        _ session: BackendSession,
        _ bundle: (classifications: [ClassificationInput], fundDocuments: [ClassificationInput])
    ) throws -> HandlerResult {
        var investmentTargets: Set<String> = []
        var identifierTargets: Set<String> = []
        for item in bundle.classifications {
            if let investmentId = item.investmentId {
                let key = "investment:\(investmentId)"
                if investmentTargets.contains(key) { throw bundleInvalid() }
                investmentTargets.insert(key)
            } else {
                let key = "identifier:\(item.identifierKey)"
                if identifierTargets.contains(key) { throw bundleInvalid() }
                identifierTargets.insert(key)
            }
        }
        var docTargets: Set<Int> = []  // lint:allow raw-id the bundle's fund-target ids
        for item in bundle.fundDocuments {
            guard let investmentId = item.investmentId else { continue }
            if docTargets.contains(investmentId) { throw bundleInvalid() }
            docTargets.insert(investmentId)
            guard let document = item.document, let fields = document.objectValue,
                case .array(let fundIdentifiers)? = fields["shareClass"]?.objectValue?["identifiers"],
                let shareClassIdentifier = item.shareClassIdentifier
            else { throw bundleInvalid() }
            let wanted = "\(shareClassIdentifier.type):\(shareClassIdentifier.exchange ?? ""):\(shareClassIdentifier.value)"
            guard fundIdentifiers.contains(where: { key($0) == wanted }) else { throw bundleInvalid() }
        }
        var targetIds: [Int] = []  // lint:allow raw-id the bundle's investment targets
        var seenTargets: Set<Int> = []  // as above
        for id in bundle.classifications.compactMap({ $0.investmentId }) + bundle.fundDocuments.compactMap({ $0.investmentId }) {
            if seenTargets.insert(id).inserted { targetIds.append(id) }
        }
        let byId = try targets(session, targetIds)
        if targetIds.contains(where: { byId[$0] == nil }) { throw bundleInvalid() }
        if bundle.fundDocuments.contains(where: { byId[$0.investmentId ?? 0] != "etf" }) {
            throw bundleInvalid()
        }
        let keptManualInvestmentIds = try manualClassificationIds(
            session, bundle.classifications.compactMap { $0.investmentId })
        try storeBundle(session, classifications: bundle.classifications, documents: bundle.fundDocuments)
        return HandlerResult(data: .object(sourceObject(
            try sources(session), keptManualInvestmentIds: keptManualInvestmentIds)))
    }

    /// `normalizedName`: trim, collapse whitespace, `toLocaleLowerCase("en")`.
    private static func normalizedName(_ value: String) -> String {
        JavaScriptCase.lowercased(ExposureArea.collapseWhitespace(JavaScriptWhitespace.trim(value)))
    }

    /// `issuerIdFor`: the own id, the matching stored name's id, or `name:<key>` cut to 128.
    private static func issuerIdFor(
        name: String, own: ExposureClassification?, byName: [String: String]
    ) -> String {
        let key = normalizedName(name)
        if let own, normalizedName(own.issuerName) == key { return own.issuerId }
        if let stored = byName[key] { return stored }
        return "name:\(key)".prefix(128).description
    }

    /// `a.localeCompare(b, "en")` as a sort predicate: the menus order mixed-case and accented
    /// names as the TypeScript route does, not by code point.
    static func englishPrecedes(_ a: String, _ b: String) -> Bool {
        a.compare(b, locale: Locale(identifier: "en")) == .orderedAscending
    }

    /// `getExposureClassifications`: the classifiable holdings, the issuers and sectors in use.
    static func classifications(_ session: BackendSession) throws -> [String: JSONValue] {
        let investments = try classifiableInvestments(session)
        let (storedClassifications, storedDocuments) = try sources(session)
        var direct: [Int: ExposureClassification] = [:]  // lint:allow raw-id holding ids
        for item in storedClassifications {
            if let investmentId = item.investmentId {
                direct[investmentId] = item
            }
        }
        var withFundDocument: Set<Int> = []  // as above
        for item in storedDocuments { withFundDocument.insert(item.investmentId) }
        var issuers: [(issuerId: String, issuerName: String)] = []  // lint:allow raw-id an external issuer key, not a table id
        var issuerSeen: Set<String> = []
        var sectors: Set<String> = []
        for item in storedClassifications {
            if !issuerSeen.contains(item.issuerId) {
                issuerSeen.insert(item.issuerId)
                issuers.append((item.issuerId, item.issuerName))
            }
            if let sector = item.sector { sectors.insert(sector) }
        }
        return [
            "items": .array(try investments.map { investment -> JSONValue in
                let classification = direct[investment.id]
                return .object([
                    "investmentId": .int(investment.id),
                    "name": .string(investment.name),
                    "symbol": investment.symbol.map(JSONValue.string) ?? .null,
                    "assetClass": .string(investment.assetClass),
                    "hasFundDocument": .bool(withFundDocument.contains(investment.id)),
                    "classification": classification.map { item -> JSONValue in
                        .object([
                            "issuerId": .string(item.issuerId),
                            "issuerName": .string(item.issuerName),
                            "sector": item.sector.map(JSONValue.string) ?? .null,
                            "issuerCountryCode": item.issuerCountryCode.map(JSONValue.string) ?? .null,
                            "origin": .string(item.origin),
                            "sourceLabel": .string(item.sourceLabel),
                            "updatedAt": .string(item.updatedAt.text),
                        ])
                    } ?? .null,
                ])
            }),
            "issuers": .array(issuers.sorted { englishPrecedes($0.1, $1.1) }.map { value -> JSONValue in
                .object(["issuerId": .string(value.issuerId), "issuerName": .string(value.issuerName)])
            }),
            "sectors": .array(sectors.sorted { englishPrecedes($0, $1) }.map { .string($0) }),
        ]
    }

    /// `saveExposureClassifications`: existence, the manual ids, the write, the fresh list.
    static func save(_ session: BackendSession, _ changes: ChangesInput) throws -> HandlerResult {
        var known: [Int] = []  // lint:allow raw-id the request's investment targets
        var seen: Set<Int> = []  // as above
        for id in changes.set.map({ $0.investmentId }) + changes.clear {
            if seen.insert(id).inserted { known.append(id) }
        }
        let byId = try targets(session, known)
        if known.contains(where: { byId[$0] == nil }) { throw changesInvalid() }
        let (storedClassifications, _) = try sources(session)
        var own: [Int: ExposureClassification] = [:]  // as above
        var byName: [String: String] = [:]
        for item in storedClassifications {
            if let investmentId = item.investmentId {
                own[investmentId] = item
            }
            let key = normalizedName(item.issuerName)
            if byName[key] == nil { byName[key] = item.issuerId }
        }
        var set: [(investmentId: Int, issuerId: String, issuerName: String, sector: String?, country: String?)] = []  // lint:allow raw-id the request's investment targets
        for item in changes.set {
            set.append((
                item.investmentId,
                issuerIdFor(name: item.issuerName, own: own[item.investmentId], byName: byName),
                ExposureArea.collapseWhitespace(JavaScriptWhitespace.trim(item.issuerName)),
                item.sector, item.country))
        }
        try storeManual(session, set: set, clear: changes.clear)
        return HandlerResult(data: .object(try classifications(session)))
    }
}

// MARK: - `aggregatePortfolioExposure`

extension ExposureArea {
    /// One holding's (or fund constituent's) share of the portfolio value.
    private struct Contribution: Sendable {
        var amount: DecimalJS
        var sourceType: String
        var investmentId: Int  // lint:allow raw-id the fund's or holding's id
        var investmentName: String
        var sourceFundName: String?
        var sourceAsOfDate: String?
        var stale: Bool
        var classification: ExposureClassification?
    }

    /// `emit`: `Number(toString(2dp half-even))`.
    private static func emitAmount(_ value: DecimalJS) -> JSONValue {
        JSValue.number(JavaScriptNumber.fromString(
            value.toDecimalPlaces(2, .halfEven).javaScriptString)).envelopeValue
    }

    /// `weight`: `total.isZero() ? 0 : emit(amount * 100 / total)`.
    private static func weight(_ amount: DecimalJS, _ total: DecimalJS) -> JSONValue {
        guard !total.isZero, let divided = try? amount.times(DecimalJS(100)).dividedBy(total) else {
            return .int(0)
        }
        return emitAmount(divided)
    }

    /// A document amount (a weight is text or a number) as `Decimal`.
    private static func money(_ value: JSValue?) throws -> DecimalJS {
        guard let value, value != .null else { return .zero }
        if let text = value.stringValue { return try DecimalJS.from(text) }
        if case .number(let number) = value { return try DecimalJS(number) }
        return .zero
    }

    /// The three dimensions the aggregate groups by.
    private enum Grouping: Sendable {
        case issuer
        case sector
        case country

        /// `classification?.[property]`: nil when absent (an empty text counts as absent).
        func key(of classification: ExposureClassification) -> String? {
            let value: String?
            switch self {
            case .issuer: value = classification.issuerId
            case .sector: value = classification.sector
            case .country: value = classification.issuerCountryCode
            }
            guard let value, !value.isEmpty else { return nil }
            return value
        }
    }

    /// `aggregateDimension`: one dimension's rows and totals.
    private static func dimension(
        _ contributions: [Contribution], _ grouping: Grouping, _ totalValue: DecimalJS
    ) -> [String: JSONValue] {
        struct Row {
            var id: String
            var label: String
            var amount: DecimalJS
            var contributions: [JSONValue] = []
        }
        var rows: [String: Row] = [:]
        var rowOrder: [String] = []
        var unclassified = DecimalJS.zero
        for contribution in contributions {
            guard let classification = contribution.classification,
                let key = grouping.key(of: classification)
            else {
                unclassified = unclassified.plus(contribution.amount)
                continue
            }
            var current = rows[key] ?? Row(
                id: key,
                label: grouping == .issuer ? classification.issuerName : key,
                amount: .zero)
            if rows[key] == nil { rowOrder.append(key) }
            current.amount = current.amount.plus(contribution.amount)
            current.contributions.append(.object([
                "sourceType": .string(contribution.sourceType),
                "investmentId": .int(contribution.investmentId),
                "investmentName": .string(contribution.investmentName),
                "sourceFundName": contribution.sourceFundName.map(JSONValue.string) ?? .null,
                "amount": emitAmount(contribution.amount),
                "sourceAsOfDate": contribution.sourceAsOfDate.map(JSONValue.string) ?? .null,
                "stale": .bool(contribution.stale),
            ]))
            rows[key] = current
        }
        let classified = rowOrder.reduce(DecimalJS.zero) { total, key in total.plus(rows[key]!.amount) }  // lint:allow force-unwrap rowOrder holds inserted keys
        let sorted = rowOrder.map { rows[$0]! }.sorted { left, right in  // lint:allow force-unwrap rowOrder holds inserted keys
            // JS `sort` of emitted amounts, descending, stable in first-seen order.
            let comparison = left.amount.toDecimalPlaces(2, .halfEven)
                .compared(to: right.amount.toDecimalPlaces(2, .halfEven))
            return comparison > 0
        }
        return [
            "rows": .array(sorted.map { row -> JSONValue in
                .object([
                    "id": .string(row.id),
                    "label": .string(row.label),
                    "amount": emitAmount(row.amount),
                    "contributions": .array(row.contributions),
                    "weightPercent": weight(row.amount, totalValue),
                ])
            }),
            "classifiedValue": emitAmount(classified),
            "classifiedWeightPercent": weight(classified, totalValue),
            "unclassifiedValue": emitAmount(unclassified),
            "unclassifiedWeightPercent": weight(unclassified, totalValue),
        ]
    }

    /// `aggregatePortfolioExposure`: the look-through over the summary and the sources.
    static func aggregate(
        _ summary: PortfolioSummaryService.Summary,
        _ stored: (classifications: [ExposureClassification], documents: [ExposureDocument])
    ) throws -> [String: JSONValue] {
        let evaluationDate = String(summary.computedAt.prefix(10))
        var direct: [Int: ExposureClassification] = [:]  // lint:allow raw-id holding ids
        var byIdentifier: [String: ExposureClassification] = [:]
        for item in stored.classifications {
            if let investmentId = item.investmentId {
                direct[investmentId] = item
            } else if !item.identifierKey.isEmpty {
                byIdentifier[item.identifierKey] = item
            }
        }
        var documents: [Int: ExposureDocument] = [:]  // as above
        for item in stored.documents { documents[item.investmentId] = item }

        var contributions: [Contribution] = []
        var uncovered = DecimalJS.zero
        var coveredCash = DecimalJS.zero
        var warnings: [JSONValue] = []
        var fundSources: [JSONValue] = []

        for holding in summary.holdings {
            let value = try DecimalJS(holding.currentValue)
            guard let source = documents[holding.id] else {
                let lower = JavaScriptCase.lowercased(holding.assetClass)
                if lower == "etf" || lower == "fund", direct[holding.id] == nil {  // lint:allow string-literal-compare fixed asset-class checks of the aggregate
                    uncovered = uncovered.plus(value)
                } else {
                    contributions.append(Contribution(
                        amount: value, sourceType: "direct", investmentId: holding.id,
                        investmentName: holding.name, sourceFundName: nil, sourceAsOfDate: nil,
                        stale: false, classification: direct[holding.id]))
                }
                continue
            }
            let document = source.document.objectValue ?? JSObject()
            let sourceBlock = document["source"]?.objectValue ?? JSObject()
            let asOfDate = sourceBlock["asOfDate"]?.stringValue ?? ""
            let staleness = document["staleness"]?.objectValue ?? JSObject()
            let coverage = document["coverage"]?.objectValue ?? JSObject()
            // Saturating: a stored document with an unvalidated number must not trap here.
            let maximumAgeDays = JavaScriptInteger.saturating(staleness["maximumAgeDays"]?.javaScriptNumber ?? 0)
            let ageDays = Int(max(0, PortfolioCore.daysBetweenYmd(asOfDate, evaluationDate).rounded(.down)))
            let stale = ageDays > maximumAgeDays
            fundSources.append(.object([
                "investmentId": .int(holding.id),
                "investmentName": .string(holding.name),
                "asOfDate": .string(asOfDate),
                "evaluatedAt": .string(evaluationDate),
                "ageDays": .int(ageDays),
                "maximumAgeDays": .int(maximumAgeDays),
                "stale": .bool(stale),
                "coverageStatus": .string(coverage["status"]?.stringValue ?? ""),
            ]))
            if stale {
                warnings.append(.object([
                    "code": .string("STALE_FUND_SOURCE"),
                    "investmentId": .int(holding.id),
                    "asOfDate": .string(asOfDate),
                    "evaluatedAt": .string(evaluationDate),
                    "ageDays": .int(ageDays),
                    "maximumAgeDays": .int(maximumAgeDays),
                ]))
            }
            for row in (document["holdings"]?.arrayValue ?? []).compactMap({ $0.objectValue }) {
                let amount = try value.times(try money(row["weightPercent"])).dividedBy(DecimalJS(100))
                if row["exposureStatus"]?.stringValue == "unsupported" {  // lint:allow string-literal-compare the document contract's enum
                    uncovered = uncovered.plus(amount)
                    continue
                }
                if row["exposureKind"]?.stringValue == "cash" {  // lint:allow string-literal-compare the document contract's enum
                    coveredCash = coveredCash.plus(amount)
                    continue
                }
                var matches: [ExposureClassification] = []
                var issuerIds: Set<String> = []
                var ambiguous = false
                for identifier in row["identifiers"]?.arrayValue ?? [] {
                    if let match = byIdentifier[key(identifier)] {
                        matches.append(match)
                        issuerIds.insert(match.issuerId)
                        if issuerIds.count > 1 { ambiguous = true }
                    }
                }
                if ambiguous {
                    var rowNumber = 0
                    if let provenance = row["provenance"]?.objectValue,
                        let number = provenance["rowNumber"]?.javaScriptNumber
                    {
                        rowNumber = JavaScriptInteger.saturating(number)
                    }
                    uncovered = uncovered.plus(amount)
                    warnings.append(.object([
                        "code": .string("AMBIGUOUS_CONSTITUENT_MAPPING"),
                        "investmentId": .int(holding.id),
                        "rowNumber": .int(rowNumber),
                    ]))
                    continue
                }
                contributions.append(Contribution(
                    amount: amount, sourceType: "fund", investmentId: holding.id,
                    investmentName: row["name"]?.stringValue ?? "", sourceFundName: holding.name,
                    sourceAsOfDate: asOfDate, stale: stale, classification: matches.first))
            }
            if let missing = try? value.times(try money(coverage["missingWeightPercent"])).dividedBy(DecimalJS(100)) {
                uncovered = uncovered.plus(missing)
            }
        }

        let totalValue = try DecimalJS(summary.totalPortfolioValue)
        return [
            "currency": .string(summary.currency),
            "computedAt": .string(summary.computedAt),
            "totalValue": emitAmount(totalValue),
            "uncoveredValue": emitAmount(uncovered),
            "uncoveredWeightPercent": weight(uncovered, totalValue),
            "coveredCashValue": emitAmount(coveredCash),
            "coveredCashWeightPercent": weight(coveredCash, totalValue),
            "fundSources": .array(fundSources),
            "issuer": .object(dimension(contributions, .issuer, totalValue)),
            "sector": .object(dimension(contributions, .sector, totalValue)),
            "issuerCountry": .object(dimension(contributions, .country, totalValue)),
            "warnings": .array(warnings),
            "scopeNotes": .array([
                .string("Issuer country is explicit source metadata, not listing or revenue geography."),
                .string("No economic foreign-exchange exposure is inferred."),
            ]),
        ]
    }
}
