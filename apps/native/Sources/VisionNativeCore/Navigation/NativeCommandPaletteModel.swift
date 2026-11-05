import Foundation
import Observation

@MainActor @Observable public final class NativeCommandPaletteModel {
    public private(set) var isOpen = false
    public var query = "" { didSet { if query != oldValue { schedule() } } }
    public private(set) var recipients: [OpenAPI.Recipient] = []
    public private(set) var quote: ResearchQuote?
    public private(set) var tickerLoading = false
    public private(set) var answer: NativeCommandPaletteAnswer?
    public private(set) var recents: [String] = []
    public private(set) var settings = NativeAppSettings.defaults
    @ObservationIgnored public var onAction: (@MainActor (NativeCommandPaletteAction) -> Void)?
    @ObservationIgnored private let service: any NativeCommandPaletteService
    @ObservationIgnored private let answers: any NativeCommandPaletteAnswers
    @ObservationIgnored private let readRecents: @MainActor () async throws -> String?
    @ObservationIgnored private let writeRecents: @MainActor (String) async throws -> Void
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var answerRevision = UUID()
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var answerTask: Task<Void, Never>?
    @ObservationIgnored private var recentsTask: Task<Void, Never>?
    @ObservationIgnored private var recentWriteTask: Task<Void, Never>?
    @ObservationIgnored private var isRetired = false
    private struct Cached<Value> {
        let value: Value
        let at: Date
    }
    @ObservationIgnored private var recipientCache: [String: Cached<[OpenAPI.Recipient]>] = [:]
    @ObservationIgnored private var quoteCache: [String: Cached<ResearchQuote?>] = [:]

    public init(
        service: any NativeCommandPaletteService, answers: any NativeCommandPaletteAnswers,
        readRecents: @escaping @MainActor () async throws -> String? = { nil },
        writeRecents: @escaping @MainActor (String) async throws -> Void = { _ in },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.answers = answers
        self.readRecents = readRecents
        self.writeRecents = writeRecents
        self.sleep = sleep
        self.now = now
    }

    public var trimmedQuery: String { NativeCommandPaletteQueries.trim(query) }
    public var tickerSymbol: String? { NativeCommandPaletteQueries.ticker(trimmedQuery) }

    public func configure(settings: NativeAppSettings) {
        guard !isRetired else { return }
        guard self.settings != settings else { return }
        let answersChanged =
            self.settings.numberFormat != settings.numberFormat
            || self.settings.defaultCurrency != settings.defaultCurrency
            || self.settings.showDecimalPlaces != settings.showDecimalPlaces
        self.settings = settings
        if isOpen && answersChanged { scheduleAnswer(context: revision, opened: visit, text: trimmedQuery) }
    }

    public func open() {
        guard !isRetired, !isOpen else { return }
        visit = UUID()
        isOpen = true
        let opened = visit
        recents = []
        let precedingWrite = recentWriteTask
        recentsTask = Task { [weak self] in
            guard let self else { return }
            await precedingWrite?.value
            let raw = try? await readRecents()
            guard isOpen, visit == opened, !Task.isCancelled else { return }
            recents = NativeCommandPaletteQueries.recents(raw)
        }
        schedule()
    }

    public func close() {
        isOpen = false
        visit = UUID()
        revision = UUID()
        searchTask?.cancel()
        answerTask?.cancel()
        recentsTask?.cancel()
        query = ""
        recipients = []
        quote = nil
        answer = nil
        tickerLoading = false
    }

    public func activate(_ entry: NativeCommandPaletteEntry) {
        guard !isRetired, isOpen else { return }
        close()
        if case .navigate(let route) = entry.action {
            let precedingWrite = recentWriteTask
            recentWriteTask = Task {
                await precedingWrite?.value
                let raw: String? = try? await readRecents()
                let current = NativeCommandPaletteQueries.recents(raw)
                let next = NativeCommandPaletteQueries.pushing(route.string, into: current)
                if let encoded = try? JSONEncoder().encode(next), let raw = String(data: encoded, encoding: .utf8) {
                    try? await writeRecents(raw)
                }
            }
        }
        onAction?(entry.action)
    }

    /// Accepted navigation history survives ordinary dismissals. The desktop
    /// restore coordinator drains it before replacing frontend storage.
    public func flushRecents() async { await recentWriteTask?.value }

    /// Called after the restore coordinator drains accepted history. A retired
    /// factory graph can never reopen or dispatch another palette action.
    public func retireForReload() {
        isRetired = true
        close()
        onAction = nil
    }

    /// Dynamic answers/search hits are force-mounted, as in cmdk. Navigation/actions
    /// use cmdk's localized label + URL fuzzy score; groups/items keep stable ties.
    public func groups(strings: any Localizing) -> [NativeCommandPaletteGroup] {
        var result: [NativeCommandPaletteGroup] = []
        func group(_ id: String, _ key: String, _ entries: [NativeCommandPaletteEntry]) {
            if !entries.isEmpty { result.append(.init(id: id, title: strings.t(key), entries: entries)) }
        }
        if let tickerSymbol, quote != nil || tickerLoading {
            let symbol = quote?.symbol ?? tickerSymbol
            group(
                "ticker", "commandPalette.market",
                [
                    .init(
                        id: "ticker", title: symbol, symbol: "chart.xyaxis.line",
                        hint: quote == nil ? strings.t("commandPalette.lookingUp") : nil,
                        action: .navigate(
                            .init(.marketLookup, query: [.init(name: "symbol", value: symbol)])),
                        quote: quote)
                ])
        }
        if let answer {
            group(
                "answer", "commandPalette.result",
                [
                    .init(
                        id: "answer", title: answer.text,
                        symbol: answer.kind == .fx ? "arrow.left.arrow.right" : "plus.forwardslash.minus",
                        hint: strings.t("commandPalette.copyHint"), action: .copy(answer.text))
                ])
        }
        if trimmedQuery.utf16.count >= 2 {
            group(
                "transaction-search", "commandPalette.actions",
                [
                    .init(
                        id: "transaction-search",
                        title: strings.t("commandPalette.searchTransactions", ["q": trimmedQuery]),
                        symbol: "list.bullet.rectangle.portrait", hint: nil,
                        action: .navigate(
                            .init(.transactions, query: [.init(name: "search", value: trimmedQuery)])))
                ])
        }
        group(
            "recipients", "nav.recipients",
            recipients.map {
                .init(
                    id: "recipient-\($0.id.rawValue)", title: $0.name, symbol: "person.2", hint: nil,
                    action: .navigate(
                        .init(
                            .transactions,
                            query: [
                                .init(name: "recipient_id", value: String($0.id.rawValue)),
                                .init(name: "filter_label", value: $0.name),
                            ])))
            })
        let pages = Self.pageGroups(adminMode: settings.adminMode).flatMap(\.pages)
        if trimmedQuery.isEmpty {
            group(
                "recent", "commandPalette.recent",
                recents.enumerated().compactMap { index, url in
                    guard let page = pages.first(where: { $0.url == url }) else { return nil }
                    return pageEntry(page, strings: strings, prefix: "recent-\(index)-")
                })
        }
        var filtered: [(group: NativeCommandPaletteGroup, score: Double, index: Int)] = []
        for (index, section) in Self.pageGroups(adminMode: settings.adminMode).enumerated() {
            let entries = section.pages.map { pageEntry($0, strings: strings) }
            let ranked = ranked(entries) { $0.title + " " + navigationURL($0.action) }
            if !ranked.isEmpty {
                filtered.append(
                    (
                        .init(id: section.key, title: strings.t(section.key), entries: ranked.map(\.entry)),
                        ranked[0].score, index
                    ))
            }
        }
        let actions: [NativeCommandPaletteEntry] = [
            .init(
                id: "new", title: strings.t("shortcuts.newTransaction"), symbol: "plus", hint: "N",
                action: .newTransaction),
            .init(id: "light", title: strings.t("layout.light"), symbol: "sun.max", hint: nil, action: .theme("light")),
            .init(id: "dark", title: strings.t("layout.dark"), symbol: "moon", hint: nil, action: .theme("dark")),
            .init(
                id: "system", title: strings.t("layout.system"), symbol: "desktopcomputer", hint: nil,
                action: .theme("system")),
            .init(
                id: "schedule", title: strings.t("layout.schedule"), symbol: "clock", hint: nil,
                action: .theme("schedule")),
            .init(
                id: "settings", title: strings.t("layout.settings"), symbol: "gearshape", hint: "⌘,", action: .settings),
            .init(
                id: "shortcuts", title: strings.t("shortcuts.title"), symbol: "keyboard", hint: "?", action: .shortcuts),
        ]
        let rankedActions = ranked(actions, value: { $0.title })
        if !rankedActions.isEmpty {
            filtered.append(
                (
                    .init(
                        id: "actions", title: strings.t("commandPalette.actions"), entries: rankedActions.map(\.entry)),
                    rankedActions[0].score, filtered.count + 5
                ))
        }
        if !query.isEmpty { filtered.sort { $0.score == $1.score ? $0.index < $1.index : $0.score > $1.score } }
        result += filtered.map(\.group)
        return result
    }

    private static func pageGroups(adminMode: Bool) -> [(key: String, pages: [NavItem])] {
        func items(_ id: NavSectionID) -> [NavItem] { NavigationRegistry.sections.first { $0.id == id }?.items ?? [] }
        var groups = [
            (key: "nav.money", pages: items(.top) + items(.money)),
            (key: "nav.wealth", pages: items(.wealth)),
            (key: "nav.research", pages: items(.research) + NavigationRegistry.footerItems),
        ]
        if adminMode { groups.append((key: "nav.admin", pages: NavigationRegistry.adminSection.items)) }
        return groups
    }

    private func pageEntry(_ page: NavItem, strings: any Localizing, prefix: String = "page-")
        -> NativeCommandPaletteEntry
    {
        .init(
            id: prefix + page.url, title: strings.t(page.titleKey), symbol: page.symbol,
            hint: page.shortcutKey.map { "G \($0.uppercased())" }, action: .navigate(.init(path: page.url)))
    }
    private func navigationURL(_ action: NativeCommandPaletteAction) -> String {
        if case .navigate(let route) = action { return route.string }
        return ""
    }
    private func ranked(_ entries: [NativeCommandPaletteEntry], value: (NativeCommandPaletteEntry) -> String)
        -> [(entry: NativeCommandPaletteEntry, score: Double)]
    {
        entries.enumerated().compactMap { index, entry -> (NativeCommandPaletteEntry, Double, Int)? in
            let score = query.isEmpty ? 1 : NativeCommandPaletteQueries.score(value(entry), query: query)
            return score > 0 ? (entry, score, index) : nil
        }.sorted { $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 > $1.1 }.map { (entry: $0.0, score: $0.1) }
    }

    private func schedule() {
        revision = UUID()
        searchTask?.cancel()
        guard !isRetired, isOpen else { return }
        let context = revision
        let opened = visit
        let text = trimmedQuery
        scheduleAnswer(context: context, opened: opened, text: text)
        searchTask = Task { [weak self] in
            guard let self else { return }
            do { try await sleep(.milliseconds(300)) } catch { return }
            guard current(context, opened) else { return }
            async let recipients: Void = loadRecipients(text, context: context, opened: opened)
            async let quote: Void = loadQuote(Self.tickerFor(text), context: context, opened: opened)
            _ = await (recipients, quote)
        }
    }
    private func scheduleAnswer(context: UUID, opened: UUID, text: String) {
        answerRevision = UUID()
        let answerContext = answerRevision
        answerTask?.cancel()
        answer = nil
        let inputs = settings
        answerTask = Task { [weak self] in
            guard let self, !text.isEmpty else { return }
            let value = try? await answers.paletteAnswer(
                query: text, numberFormat: inputs.numberFormat, currency: inputs.defaultCurrency,
                decimals: inputs.showDecimalPlaces)
            guard current(context, opened), answerRevision == answerContext else { return }
            answer = value
        }
    }
    private static func tickerFor(_ query: String) -> String? { NativeCommandPaletteQueries.ticker(query) }
    private func current(_ context: UUID, _ opened: UUID) -> Bool {
        isOpen && revision == context && visit == opened && !Task.isCancelled
    }
    private func loadRecipients(_ text: String, context: UUID, opened: UUID) async {
        guard current(context, opened) else { return }
        guard text.utf16.count >= 2 else {
            recipients = []
            return
        }
        let cached = recipientCache[text]
        recipients = cached?.value ?? []
        if let cached, now().timeIntervalSince(cached.at) < 30 { return }
        let value = try? await service.paletteRecipients(query: text)
        if let value { recipientCache[text] = .init(value: value, at: now()) }
        guard current(context, opened) else { return }
        recipients = value ?? cached?.value ?? []
    }
    private func loadQuote(_ symbol: String?, context: UUID, opened: UUID) async {
        guard current(context, opened) else { return }
        guard let symbol else {
            quote = nil
            tickerLoading = false
            return
        }
        let cached = quoteCache[symbol]
        quote = cached?.value
        if let cached, now().timeIntervalSince(cached.at) < 30 {
            tickerLoading = false
            return
        }
        tickerLoading = true
        do {
            let value = try await service.paletteQuote(symbol: symbol)
            quoteCache[symbol] = .init(value: value, at: now())
            guard current(context, opened) else { return }
            quote = value
        } catch {
            guard current(context, opened) else { return }
            quote = cached?.value
        }
        tickerLoading = false
    }
}
