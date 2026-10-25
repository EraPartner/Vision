import Foundation
import Observation

public enum ResearchReadKey {
    private static func key(_ values: [String]) -> String {
        String(decoding: (try? APIBody.encode(values)) ?? Data(), as: UTF8.self)
    }
    public static func search(source: ResearchSearchSource, query: String) -> String {
        key(["search", source.rawValue, query])
    }
    public static func chart(symbol: String, range: String, assetClass: String? = nil, provider: String? = nil)
        -> String
    { key(["research-chart", symbol, range, assetClass ?? "", provider ?? ""]) }
    public static func scorecard(symbol: String, assetClass: String? = nil) -> String {
        key(["research-scorecard", symbol, assetClass ?? ""])
    }
    public static func quotes(symbols: [String], detail: String = "basic") -> String {
        key(["market-quotes", detail] + symbols)
    }
    public static func marketChart(symbol: String, range: String, interval: String) -> String {
        key(["market-chart", symbol, range, interval])
    }
    public static func news(symbols: [String], count: Int) -> String { key(["market-news", String(count)] + symbols) }
    public static let watchlist = "watchlist"
    public static let investments = "research-investments-all-500"
}
@MainActor public final class ResearchReadCache {
    private struct Entry {
        let value: any Sendable
        let date: Date
    }
    private struct Pending {
        let id: UUID
        let task: Task<any Sendable, Error>
    }
    private var entries: [String: Entry] = [:]
    private var pending: [String: Pending] = [:]
    private let now: @Sendable () -> Date
    public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }
    public func request<Value: Sendable>(
        key: String, freshFor: TimeInterval, force: Bool = false, fetch: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        if !force, let entry = entries[key], now().timeIntervalSince(entry.date) < freshFor,
            let value = entry.value as? Value
        {
            return value
        }
        let current: Pending
        if let existing = pending[key] {
            current = existing
        } else {
            current = Pending(id: UUID(), task: Task { try await fetch() as any Sendable })
            pending[key] = current
        }
        do {
            let raw = try await current.task.value
            guard let value = raw as? Value else { throw ResearchDecode.failure("Research cache type mismatch") }
            if pending[key]?.id == current.id {
                entries[key] = Entry(value: value, date: now())
                pending[key] = nil
            }
            return value
        } catch {
            if pending[key]?.id == current.id { pending[key] = nil }
            throw error
        }
    }
    public func cached<Value: Sendable>(key: String, as type: Value.Type) -> Value? {
        entries[key]?.value as? Value
    }
    public func invalidate(prefix: String? = nil) {
        guard let prefix else {
            entries.removeAll()
            pending.removeAll()
            return
        }
        entries = entries.filter { !$0.key.hasPrefix(prefix) }
        pending = pending.filter { !$0.key.hasPrefix(prefix) }
    }
    public func invalidate(key: String) {
        entries[key] = nil
        pending[key] = nil
    }
}
public enum ResearchSearchSource: String, Sendable { case research, market }
@MainActor @Observable public final class ResearchSearchModel {
    public var searchText = "" { didSet { if searchText != oldValue { queueSearch() } } }
    public var isOnline = true {
        didSet { if isOnline != oldValue { queueSearch(debounce: false) } }
    }
    public private(set) var items: [ResearchSearchItem] = []
    public private(set) var meta: ResearchMeta?
    public private(set) var isSearching = false
    public private(set) var error: String?
    public private(set) var searchedQuery: String?
    public var isOpen: Bool {
        let current = query
        return current.count >= minLength && !searchText.isEmpty && searchedQuery == current
    }
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private let source: ResearchSearchSource
    @ObservationIgnored private let trim: Bool
    @ObservationIgnored private let minLength: Int
    @ObservationIgnored private let debounceNanoseconds: UInt64
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    private var query: String { trim ? searchText.trimmingCharacters(in: .whitespacesAndNewlines) : searchText }
    public init(
        service: any ResearchService, source: ResearchSearchSource, trim: Bool = true, minLength: Int = 1,
        cache: ResearchReadCache? = nil, debounceMilliseconds: Int = 300
    ) {
        self.service = service
        self.source = source
        self.trim = trim
        self.minLength = minLength
        self.cache = cache ?? ResearchReadCache()
        debounceNanoseconds = UInt64(max(0, debounceMilliseconds)) * 1_000_000
    }
    private func queueSearch(debounce: Bool = true) {
        cancel()
        items = []
        meta = nil
        error = nil
        searchedQuery = nil
        let text = query
        guard text.count >= minLength else { return }
        let generation = revision
        task = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds: debounceNanoseconds) } catch { return }
            guard generation == revision, text == query else { return }
            searchedQuery = text
            if !isOnline {
                if let result = cache.cached(
                    key: ResearchReadKey.search(source: source, query: text),
                    as: ResearchSnapshot<ResearchSearchData>.self)
                {
                    items = result.data.items
                    meta = source == .research ? result.meta : nil
                }
                return
            }
            isSearching = true
            defer { if generation == revision { isSearching = false } }
            do {
                let service = service
                let source = source
                let result: ResearchSnapshot<ResearchSearchData> = try await cache.request(
                    key: ResearchReadKey.search(source: source, query: text), freshFor: 60
                ) {
                    if source == .research { return try await service.researchSearch(query: text) }
                    return try await ResearchSnapshot(data: service.marketSearch(query: text))
                }
                guard generation == revision, text == query else { return }
                items = result.data.items
                meta = source == .research ? result.meta : nil
            } catch { if generation == revision, text == query { self.error = error.localizedDescription } }
        }
    }
    public func clear() {
        searchText = ""
        cancel()
        items = []
        meta = nil
        error = nil
        searchedQuery = nil
    }
    public func cancel() {
        revision = UUID()
        task?.cancel()
        task = nil
        isSearching = false
    }
    public func invalidate() {
        cache.invalidate(prefix: "[\"search\"")
        queueSearch()
    }
}
