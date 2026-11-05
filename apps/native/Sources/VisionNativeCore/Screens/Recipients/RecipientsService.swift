import Foundation

/// The API calls of `/recipients` (apps/frontend/src/lib/api/recipients.ts), so tests can
/// use a fake. The method names say "payee" so they do not clash with the recipient calls
/// other screens' services add to `APIClient`.
public protocol RecipientsService: Sendable {
    /// `getRecipients({ limit, offset, active, search, uncategorized, sort_by, sort_dir })`.
    func payeePage(_ query: PayeePageQuery, offset: Int, limit: Int) async throws -> PayeePage
    /// `createRecipient({ name, notes })`: `true` when it was created, `false` when a payee
    /// with that name already existed (`wasCreated`).
    func createPayee(name: String, notes: String?) async throws -> Bool
    /// `updateRecipient(id, data)`.
    func updatePayee(id: RecipientID, patch: PayeePatch) async throws
    /// `deleteRecipient(id)`.
    func deletePayee(id: RecipientID) async throws
    /// `mergeRecipients(primaryId, aliasIds)`.
    func mergePayees(primaryId: RecipientID, aliasIds: [RecipientID]) async throws -> PayeeMergeResult
    /// `unmergeRecipient(id)`.
    func unmergePayee(id: RecipientID) async throws
    /// `listRecipientPatterns(recipientId)`.
    func matchRules(recipientId: RecipientID) async throws -> [OpenAPI.RecipientPattern]
    /// `createRecipientPattern(recipientId, data)`.
    func createMatchRule(recipientId: RecipientID, body: MatchRuleBody) async throws
    /// `updateRecipientPattern(recipientId, patternId, data)`.
    func updateMatchRule(recipientId: RecipientID, patternId: RecipientPatternID, patch: MatchRulePatch) async throws
    /// `deleteRecipientPattern(recipientId, patternId)`.
    func deleteMatchRule(recipientId: RecipientID, patternId: RecipientPatternID) async throws
    /// `previewRecipientPattern(recipientId, { pattern, pattern_kind, case_sensitive })`:
    /// `matchCount`.
    func previewMatchRule(recipientId: RecipientID, pattern: String, kind: MatchRuleKind, caseSensitive: Bool)
        async throws -> Int
}

/// The list query of the payees table and of Merge payees' full list.
public struct PayeePageQuery: Equatable, Sendable {
    /// `active: !showAll` (the API reads `active=false` as "include inactive").
    public var active: Bool
    /// The gated server search; `nil` for none.
    public var search: String?
    public var uncategorized: Bool?
    public var sortBy: String?
    public var sortDir: String?

    public init(
        active: Bool, search: String? = nil, uncategorized: Bool? = nil, sortBy: String? = nil, sortDir: String? = nil
    ) {
        self.active = active
        self.search = search
        self.uncategorized = uncategorized
        self.sortBy = sortBy
        self.sortDir = sortDir
    }
}

/// One page of payees and the server total.
public struct PayeePage: Equatable, Sendable {
    public let items: [OpenAPI.Recipient]
    public let total: Int

    public init(items: [OpenAPI.Recipient], total: Int) {
        self.items = items
        self.total = total
    }
}

/// `RecipientUpdate` as the payees page sends it: the inline edit's `{ name, notes,
/// is_active }`, the status flip's `{ is_active }`, or the category's
/// `{ default_category_id }`, where `null` clears the default (the generated body drops a
/// `nil`).
public struct PayeePatch: Equatable, Sendable, Encodable {
    public var name: String?
    public var notes: String?
    public var isActive: Bool?
    /// `.some(nil)` sends `null`.
    public var defaultCategoryId: CategoryID??

    public init(name: String? = nil, notes: String? = nil, isActive: Bool? = nil, defaultCategoryId: CategoryID?? = nil) {
        self.name = name
        self.notes = notes
        self.isActive = isActive
        self.defaultCategoryId = defaultCategoryId
    }

    enum CodingKeys: String, CodingKey {
        case name
        case notes
        case isActive = "is_active"
        case defaultCategoryId = "default_category_id"
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(isActive, forKey: .isActive)
        if let defaultCategoryId {
            if let id = defaultCategoryId {
                try container.encode(id, forKey: .defaultCategoryId)
            } else {
                try container.encodeNil(forKey: .defaultCategoryId)
            }
        }
    }
}

/// `POST /api/recipients/:id/merge`'s answer: the primary's name, the merged ids and the
/// rule suggestion, if any.
public struct PayeeMergeResult: Equatable, Sendable, Decodable {
    public struct Primary: Equatable, Sendable, Decodable {
        public let id: RecipientID
        public let name: String

        public init(id: RecipientID, name: String) {
            self.id = id
            self.name = name
        }
    }

    /// `patternSuggestion`.
    public struct Suggestion: Equatable, Sendable, Decodable {
        public let pattern: String
        public let kind: String
        public let matchCount: Int

        public init(pattern: String, kind: String, matchCount: Int) {
            self.pattern = pattern
            self.kind = kind
            self.matchCount = matchCount
        }
    }

    public let primary: Primary
    public let mergedIds: [RecipientID]
    public let suggestion: Suggestion?

    public init(primary: Primary, mergedIds: [RecipientID], suggestion: Suggestion? = nil) {
        self.primary = primary
        self.mergedIds = mergedIds
        self.suggestion = suggestion
    }

    enum CodingKeys: String, CodingKey {
        case primary
        case mergedIds = "merged_ids"
        case suggestion = "patternSuggestion"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        primary = try container.decode(Primary.self, forKey: .primary)
        mergedIds = try container.decodeIfPresent([RecipientID].self, forKey: .mergedIds) ?? []
        suggestion = try container.decodeIfPresent(Suggestion.self, forKey: .suggestion)
    }
}

/// A match rule's kind (`pattern_kind`).
public enum MatchRuleKind: String, CaseIterable, Sendable {
    case literalPrefix = "literal_prefix"
    case glob
    case regex

    /// The form's kind for a stored rule's kind; `nil` for a kind this client does not know.
    public init?(_ kind: OpenAPI.RecipientPattern.PatternKind) {
        self.init(rawValue: kind.rawValue)
    }

    /// `recipientPatterns.kindLiteralPrefix`, `kindGlob` or `kindRegex`.
    public var labelKey: String {
        switch self {
        case .literalPrefix: return "recipientPatterns.kindLiteralPrefix"
        case .glob: return "recipientPatterns.kindGlob"
        case .regex: return "recipientPatterns.kindRegex"
        }
    }
}

/// The Match rules form's create body: `notes: null` stores none.
public struct MatchRuleBody: Equatable, Sendable, Encodable {
    public let pattern: String
    public let kind: MatchRuleKind
    public let caseSensitive: Bool
    public let priority: Int?
    public let notes: String?

    public init(pattern: String, kind: MatchRuleKind, caseSensitive: Bool, priority: Int?, notes: String?) {
        self.pattern = pattern
        self.kind = kind
        self.caseSensitive = caseSensitive
        self.priority = priority
        self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case pattern
        case kind = "pattern_kind"
        case caseSensitive = "case_sensitive"
        case priority
        case notes
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pattern, forKey: .pattern)
        try container.encode(kind.rawValue, forKey: .kind)
        try container.encode(caseSensitive, forKey: .caseSensitive)
        try container.encodeIfPresent(priority, forKey: .priority)
        if let notes {
            try container.encode(notes, forKey: .notes)
        } else {
            try container.encodeNil(forKey: .notes)
        }
    }
}

/// `RecipientPatternUpdate`: the form's full edit (`notes: null` clears the note, which the
/// generated body cannot send) or the Active switch's `{ is_active }`.
public struct MatchRulePatch: Equatable, Sendable, Encodable {
    public var pattern: String?
    public var kind: MatchRuleKind?
    public var caseSensitive: Bool?
    public var priority: Int?
    /// `.some(nil)` sends `null`.
    public var notes: String??
    public var isActive: Bool?

    public init() {}

    /// The form's Save in edit mode.
    public init(_ body: MatchRuleBody) {
        pattern = body.pattern
        kind = body.kind
        caseSensitive = body.caseSensitive
        priority = body.priority
        notes = .some(body.notes)
    }

    /// The Active switch.
    public static func active(_ isActive: Bool) -> MatchRulePatch {
        var patch = MatchRulePatch()
        patch.isActive = isActive
        return patch
    }

    enum CodingKeys: String, CodingKey {
        case pattern
        case kind = "pattern_kind"
        case caseSensitive = "case_sensitive"
        case priority
        case notes
        case isActive = "is_active"
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(pattern, forKey: .pattern)
        try container.encodeIfPresent(kind?.rawValue, forKey: .kind)
        try container.encodeIfPresent(caseSensitive, forKey: .caseSensitive)
        try container.encodeIfPresent(priority, forKey: .priority)
        if let notes {
            if let text = notes {
                try container.encode(text, forKey: .notes)
            } else {
                try container.encodeNil(forKey: .notes)
            }
        }
        try container.encodeIfPresent(isActive, forKey: .isActive)
    }
}

extension APIClient: RecipientsService {
    public func payeePage(_ query: PayeePageQuery, offset: Int, limit: Int) async throws -> PayeePage {
        let list = try await send(
            OpenAPIOperations.GetRecipients(
                limit: limit, offset: offset, search: query.search, active: query.active,
                uncategorized: query.uncategorized, sortBy: query.sortBy, sortDir: query.sortDir))
        return PayeePage(items: list.items, total: list.total)
    }

    public func createPayee(name: String, notes: String?) async throws -> Bool {
        try await send(OpenAPIOperations.CreateRecipient(body: OpenAPI.RecipientCreate(name: name, notes: notes))).created
    }

    public func updatePayee(id: RecipientID, patch: PayeePatch) async throws {
        _ = try await send(PayeePatchRequest(id: id, patch: patch))
    }

    public func deletePayee(id: RecipientID) async throws {
        _ = try await send(OpenAPIOperations.DeleteRecipient(id: id))
    }

    public func mergePayees(primaryId: RecipientID, aliasIds: [RecipientID]) async throws -> PayeeMergeResult {
        try await send(PayeeMergeRequest(primaryId: primaryId, aliasIds: aliasIds))
    }

    public func unmergePayee(id: RecipientID) async throws {
        _ = try await send(OpenAPIOperations.UnmergeRecipient(id: id))
    }

    public func matchRules(recipientId: RecipientID) async throws -> [OpenAPI.RecipientPattern] {
        try await send(OpenAPIOperations.GetRecipientPatterns(id: recipientId)).items
    }

    public func createMatchRule(recipientId: RecipientID, body: MatchRuleBody) async throws {
        _ = try await send(MatchRuleCreateRequest(recipientId: recipientId, body: body))
    }

    public func updateMatchRule(recipientId: RecipientID, patternId: RecipientPatternID, patch: MatchRulePatch) async throws {
        _ = try await send(MatchRulePatchRequest(recipientId: recipientId, patternId: patternId, patch: patch))
    }

    public func deleteMatchRule(recipientId: RecipientID, patternId: RecipientPatternID) async throws {
        _ = try await send(OpenAPIOperations.DeleteRecipientPattern(id: recipientId, patternId: patternId))
    }

    public func previewMatchRule(recipientId: RecipientID, pattern: String, kind: MatchRuleKind, caseSensitive: Bool)
        async throws -> Int
    {
        try await send(
            OpenAPIOperations.PreviewRecipientPattern(
                id: recipientId,
                body: .init(pattern: pattern, patternKind: .init(rawValue: kind.rawValue), caseSensitive: caseSensitive))
        ).matchCount
    }
}

// MARK: - Hand-written requests

/// `PATCH /api/recipients/{id}` (operationId `updateRecipient`) with `PayeePatch`. The
/// answer is not read (the page refetches).
public struct PayeePatchRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.UpdateRecipient.operationId
    public static let method = OpenAPIOperations.UpdateRecipient.method
    public static let pathTemplate = OpenAPIOperations.UpdateRecipient.pathTemplate

    public let id: RecipientID
    public let patch: PayeePatch

    public init(id: RecipientID, patch: PayeePatch) {
        self.id = id
        self.patch = patch
    }

    public var path: String { OpenAPIOperations.UpdateRecipient(id: id, body: OpenAPI.RecipientUpdate()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}

/// `POST /api/recipients/{id}/merge` (operationId `mergeRecipient`): the spec leaves the
/// answer an untyped envelope, so this request reads the fields the toasts need.
public struct PayeeMergeRequest: APIOperation {
    public typealias Response = PayeeMergeResult
    public static let operationId = OpenAPIOperations.MergeRecipient.operationId
    public static let method = OpenAPIOperations.MergeRecipient.method
    public static let pathTemplate = OpenAPIOperations.MergeRecipient.pathTemplate

    public let primaryId: RecipientID
    public let aliasIds: [RecipientID]

    public init(primaryId: RecipientID, aliasIds: [RecipientID]) {
        self.primaryId = primaryId
        self.aliasIds = aliasIds
    }

    public var path: String {
        OpenAPIOperations.MergeRecipient(id: primaryId, body: .init(aliasIds: aliasIds)).path
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(OpenAPIOperations.MergeRecipient.Body(aliasIds: aliasIds))
    }
}

/// `POST /api/recipients/{id}/patterns` (operationId `createRecipientPattern`) with
/// `MatchRuleBody` (`notes: null` for no note).
public struct MatchRuleCreateRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.CreateRecipientPattern.operationId
    public static let method = OpenAPIOperations.CreateRecipientPattern.method
    public static let pathTemplate = OpenAPIOperations.CreateRecipientPattern.pathTemplate

    public let recipientId: RecipientID
    public let body: MatchRuleBody

    public init(recipientId: RecipientID, body: MatchRuleBody) {
        self.recipientId = recipientId
        self.body = body
    }

    public var path: String {
        OpenAPIOperations.CreateRecipientPattern(id: recipientId, body: .init(pattern: body.pattern)).path
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(body)
    }
}

/// `PATCH /api/recipients/{id}/patterns/{patternId}` (operationId `updateRecipientPattern`)
/// with `MatchRulePatch`.
public struct MatchRulePatchRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.UpdateRecipientPattern.operationId
    public static let method = OpenAPIOperations.UpdateRecipientPattern.method
    public static let pathTemplate = OpenAPIOperations.UpdateRecipientPattern.pathTemplate

    public let recipientId: RecipientID
    public let patternId: RecipientPatternID
    public let patch: MatchRulePatch

    public init(recipientId: RecipientID, patternId: RecipientPatternID, patch: MatchRulePatch) {
        self.recipientId = recipientId
        self.patternId = patternId
        self.patch = patch
    }

    public var path: String {
        OpenAPIOperations.UpdateRecipientPattern(id: recipientId, patternId: patternId, body: .init()).path
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}
