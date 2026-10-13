import Foundation
import Observation

/// The lists behind the shared pickers (`RecipientCombobox`, `CategoryCombobox`,
/// `AccountCombobox`, `TagInput`), so tests can use a fake.
public protocol PickerDataService: Sendable {
    /// `useRecipients({ limit, active: false, search })`: the include-inactive page.
    func recipients(search: String?, limit: Int) async throws -> [OpenAPI.Recipient]
    /// `useRecipient(id)` / `getRecipient(id)`.
    func recipient(id: Int) async throws -> OpenAPI.Recipient
    /// `useAccounts({ active: "true" })`.
    func accounts() async throws -> [OpenAPI.Account]
    /// `useCategoryTree()`: every node, assignable ancestors included.
    func categories() async throws -> [OpenAPI.CategoryNode]
    /// `useTags({ is_active: true })`.
    func tags() async throws -> [OpenAPI.Tag]
    /// `createTag({ slug, color })`.
    func createTag(slug: String, color: String?) async throws
}

extension APIClient: PickerDataService {
    public func recipients(search: String?, limit: Int) async throws -> [OpenAPI.Recipient] {
        try await send(OpenAPIOperations.GetRecipients(limit: limit, search: search, active: false)).items
    }

    public func recipient(id: Int) async throws -> OpenAPI.Recipient {
        try await send(OpenAPIOperations.GetRecipient(id: id))
    }

    public func accounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "true")).items
    }

    public func categories() async throws -> [OpenAPI.CategoryNode] {
        // The generated `GetCategoryTree` decodes `data` as the whole envelope (see
        // `CategoryTreeRequest`), so the tree is read through the hand-written request.
        try await send(CategoryTreeRequest()).items
    }

    public func tags() async throws -> [OpenAPI.Tag] {
        try await send(OpenAPIOperations.GetTags(active: "true")).items
    }

    public func createTag(slug: String, color: String?) async throws {
        _ = try await send(OpenAPIOperations.CreateTag(body: OpenAPI.TagCreate(slug: slug, color: color)))
    }
}

/// The shared picker lists, loaded once per screen visit like their React Query caches: the
/// first recipients page, server-searched recipient pages, the active accounts, the category
/// tree and the active tags. A list that fails to load stays empty (`data ?? []`).
@MainActor
@Observable
public final class PickerDataModel {
    /// `BASE_PAGE.limit`: the unsearched recipient page.
    public nonisolated static let baseRecipientLimit = 100
    /// `SEARCH_PAGE_LIMIT`: a searched recipient page.
    public nonisolated static let searchRecipientLimit = 1000
    /// `SEARCH_DEBOUNCE_MS`.
    public nonisolated static let searchDebounce: Duration = .milliseconds(300)
    /// `TagInput`'s `maxTags`.
    public nonisolated static let maxTags = 20
    /// The jewel-tone `PALETTE` of `TagInput` and the `tags.color.*` name of each swatch.
    public nonisolated static let tagPalette: [TagSwatch] = [
        TagSwatch(color: "hsl(355, 60%, 52%)", nameKey: "tags.color.crimson"),
        TagSwatch(color: "hsl(20, 68%, 52%)", nameKey: "tags.color.coral"),
        TagSwatch(color: "hsl(40, 64%, 50%)", nameKey: "tags.color.amber"),
        TagSwatch(color: "hsl(52, 62%, 46%)", nameKey: "tags.color.gold"),
        TagSwatch(color: "hsl(96, 42%, 42%)", nameKey: "tags.color.moss"),
        TagSwatch(color: "hsl(150, 50%, 38%)", nameKey: "tags.color.emerald"),
        TagSwatch(color: "hsl(174, 50%, 40%)", nameKey: "tags.color.teal"),
        TagSwatch(color: "hsl(192, 58%, 44%)", nameKey: "tags.color.cyan"),
        TagSwatch(color: "hsl(210, 62%, 50%)", nameKey: "tags.color.azure"),
        TagSwatch(color: "hsl(244, 46%, 58%)", nameKey: "tags.color.indigo"),
        TagSwatch(color: "hsl(280, 46%, 56%)", nameKey: "tags.color.violet"),
        TagSwatch(color: "hsl(322, 54%, 54%)", nameKey: "tags.color.magenta"),
    ]

    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var categories: [OpenAPI.CategoryNode] = []
    public private(set) var tags: [OpenAPI.Tag] = []
    /// The unsearched recipients page.
    public private(set) var baseRecipients: [OpenAPI.Recipient] = []
    /// Server answers per trimmed search text.
    public private(set) var searchedRecipients: [String: [OpenAPI.Recipient]] = [:]
    /// `useRecipient(id)` answers, for the closed combobox's label.
    public private(set) var recipientsByID: [Int: OpenAPI.Recipient] = [:]
    public private(set) var isLoaded = false

    @ObservationIgnored private let service: any PickerDataService
    @ObservationIgnored private var loading: Task<Void, Never>?

    public init(service: any PickerDataService) {
        self.service = service
    }

    /// Loads every list once; a second caller awaits the first.
    public func load() async {
        if isLoaded { return }
        if let loading {
            await loading.value
            return
        }
        let task = Task { await fetchAll() }
        loading = task
        await task.value
        loading = nil
        isLoaded = true
    }

    /// Forgets the lists, so the next visit refetches them.
    public func reset() {
        isLoaded = false
        searchedRecipients = [:]
    }

    private func fetchAll() async {
        let service = service
        async let accounts = service.accounts()
        async let categories = service.categories()
        async let tags = service.tags()
        async let recipients = service.recipients(search: nil, limit: Self.baseRecipientLimit)
        self.accounts = (try? await accounts) ?? []
        self.categories = (try? await categories) ?? []
        self.tags = (try? await tags) ?? []
        baseRecipients = (try? await recipients) ?? []
    }

    // MARK: Recipients

    /// The recipients the combobox lists for a search text: the first page when the trimmed
    /// text is empty, else the server's answer for it (nothing until it arrives).
    public func recipients(matching search: String) -> [OpenAPI.Recipient] {
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return baseRecipients }
        return searchedRecipients[trimmed] ?? []
    }

    /// Runs the server search for a (debounced) text.
    public func searchRecipients(_ search: String) async {
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, searchedRecipients[trimmed] == nil else { return }
        if let found = try? await service.recipients(search: trimmed, limit: Self.searchRecipientLimit) {
            searchedRecipients[trimmed] = found
        }
    }

    /// `useRecipient(value)`: fetches the selected recipient for its label.
    public func resolveRecipient(_ id: Int?) async {
        guard let id, recipientsByID[id] == nil else { return }
        if let found = try? await service.recipient(id: id) {
            recipientsByID[id] = found
        }
    }

    /// The closed combobox's label: the selected recipient, else `nil` for the placeholder.
    public func recipientName(_ id: Int?) -> String? {
        guard let id else { return nil }
        return knownRecipient(id)?.name
    }

    /// The recipient with this id from any loaded list.
    public func knownRecipient(_ id: Int) -> OpenAPI.Recipient? {
        if let known = recipientsByID[id] { return known }
        if let listed = baseRecipients.first(where: { $0.id == id }) { return listed }
        for page in searchedRecipients.values {
            if let listed = page.first(where: { $0.id == id }) { return listed }
        }
        return nil
    }

    /// `RecipientCombobox active`: the listed recipients that are active.
    public func activeRecipients(matching search: String) -> [OpenAPI.Recipient] {
        recipients(matching: search).filter(\.isActive)
    }

    /// The combobox's create row (`allowCreate`): the trimmed text when no listed recipient
    /// has that name (any case).
    public static func creatableName(_ search: String, listed: [OpenAPI.Recipient]) -> String? {
        let typed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        let wanted = typed.lowercased()
        if listed.contains(where: { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == wanted }) {
            return nil
        }
        return typed
    }

    /// A payee `POST /api/recipients` created or returned: known for the combobox's label,
    /// and the cached searches refetch (`invalidateQueries(recipientKeys.all)`).
    public func remember(_ recipient: OpenAPI.Recipient) {
        recipientsByID[recipient.id] = recipient
        searchedRecipients = [:]
        if !baseRecipients.contains(where: { $0.id == recipient.id }) {
            baseRecipients.append(recipient)
        }
    }

    // MARK: Categories

    /// The active categories the combobox lists.
    public var activeCategories: [OpenAPI.CategoryNode] {
        categories.filter { $0.isActive }
    }

    /// `path.join(" / ")` of an active category, the combobox's label.
    public func categoryLabel(_ id: Int?) -> String? {
        guard let id, let node = activeCategories.first(where: { $0.id == id }) else { return nil }
        return Self.label(node)
    }

    /// The tree's own name for a category id (any node).
    public func categoryName(_ id: Int?) -> String? {
        guard let id else { return nil }
        return categories.first(where: { $0.id == id })?.name
    }

    public static func label(_ node: OpenAPI.CategoryNode) -> String {
        node.path.joined(separator: " / ")
    }

    // MARK: Accounts

    /// `AccountCombobox`'s label: the account whose name matches (trimmed, any case) shows its
    /// display name, else the stored name, else `nil` for the placeholder.
    public func accountLabel(name: String) -> String? {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let account = accounts.first(where: {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == wanted
        }) {
            return account.displayName.flatMap { $0.isEmpty ? nil : $0 } ?? account.name
        }
        return name.isEmpty ? nil : name
    }

    // MARK: Tags

    /// The active tag with this slug.
    public func tag(_ slug: String) -> OpenAPI.Tag? {
        tags.first { $0.slug == slug }
    }

    /// `suggestions`: active tags not yet chosen whose slug contains the typed slug.
    public func tagSuggestions(typed: String, selected: [String]) -> [OpenAPI.Tag] {
        let slug = TagSlug.slugify(typed)
        return tags.filter { tag in
            !selected.contains(tag.slug) && (typed.isEmpty || tag.slug.contains(slug))
        }
    }

    /// `TagFilterCombobox`'s list: the active tags whose slug contains the search (any case).
    public func tags(matching search: String) -> [OpenAPI.Tag] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return tags }
        return tags.filter { $0.slug.lowercased().contains(needle) }
    }

    /// A tag item of the multi-select: the slug joins or leaves the selection.
    public nonisolated static func toggling(_ slug: String, in slugs: [String]) -> [String] {
        slugs.contains(slug) ? slugs.filter { $0 != slug } : slugs + [slug]
    }

    /// `createTag`, then the tag list again. A failure (the tag may already exist) does not
    /// stop the caller adding the slug, as on the web; it is returned for `tags.createFailed`.
    @discardableResult
    public func createTag(slug: String, color: String?) async -> APIError? {
        var failure: APIError?
        do {
            try await service.createTag(slug: slug, color: color)
        } catch {
            failure = APIError.wrapping(error)
        }
        if let refreshed = try? await service.tags() {
            tags = refreshed
        }
        return failure
    }
}

/// One swatch of the tag colour palette.
public struct TagSwatch: Equatable, Sendable {
    /// The CSS colour the tag stores.
    public let color: String
    public let nameKey: String

    public init(color: String, nameKey: String) {
        self.color = color
        self.nameKey = nameKey
    }
}

/// `TagInput`'s keyboard and list rules over the chosen slugs.
public struct TagInputState: Equatable, Sendable {
    public var selected: [String]
    public var typed = ""

    public init(selected: [String]) {
        self.selected = selected
    }

    /// `liveSlug`.
    public var liveSlug: String { TagSlug.slugify(typed) }

    /// The hint `tags.slugifyHint` shows when the slug differs from the typed text.
    public var showsSlugHint: Bool { !liveSlug.isEmpty && liveSlug != typed.trimmingCharacters(in: .whitespaces) }

    /// `canCreate`: a slug no active tag has, while there is room.
    public func canCreate(existing: [OpenAPI.Tag]) -> Bool {
        !liveSlug.isEmpty && !existing.contains { $0.slug == liveSlug } && selected.count < PickerDataModel.maxTags
    }

    /// `addSlug`.
    public mutating func add(_ slug: String) {
        guard !slug.isEmpty, !selected.contains(slug), selected.count < PickerDataModel.maxTags else { return }
        selected.append(slug)
    }

    public mutating func remove(_ slug: String) {
        selected.removeAll { $0 == slug }
    }

    /// Backspace in an empty input removes the last tag.
    public mutating func backspace() {
        guard typed.isEmpty, let last = selected.last else { return }
        remove(last)
    }

    /// What Enter or a comma does with the typed text.
    public enum Commit: Equatable, Sendable {
        case nothing
        /// An active tag matched the slug and was added.
        case added
        /// The slug is new: the caller creates the tag, then adds it.
        case create(String)
    }

    public mutating func commit(existing: [OpenAPI.Tag]) -> Commit {
        let slug = liveSlug
        guard !slug.isEmpty else { return .nothing }
        if existing.contains(where: { $0.slug == slug }) {
            add(slug)
            typed = ""
            return .added
        }
        return canCreate(existing: existing) ? .create(slug) : .nothing
    }
}
