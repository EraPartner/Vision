import Foundation
import Observation

public enum ResearchChartStorageStatus: String, Sendable { case loading, saving, saved, failed }
public enum ResearchChartConfirmation: String, Sendable { case new, share }
@MainActor @Observable public final class ResearchChartBuilderModel {
    public private(set) var library: ResearchChartBuilderLibrary = .empty
    public private(set) var isStorageLoaded = false
    public private(set) var isStorageAction = false
    public private(set) var storageStatus: ResearchChartStorageStatus = .loading
    public private(set) var storageError: String?
    public var state: ResearchChartBuilderState {
        get { library.activeState }
        set {
            guard isStorageLoaded, !isStorageAction, newValue != state else { return }
            let old = state
            var next = library
            do {
                try next.setActiveState(newValue, now: timestamp())
                try next.validate()
            } catch { return }
            library = next
            _ = queueWrite(next)
            stateChanged(from: old)
        }
    }
    public var activeLayout: ResearchChartBuilderLayout? { library.activeLayout }
    public var canEdit: Bool { isStorageLoaded && !isStorageAction }
    public var isSaveDialogPresented = false
    public var layoutName = ""
    public private(set) var pendingConfirmation: ResearchChartConfirmation?
    public private(set) var snapshots: [String: ResearchSnapshot<ResearchChartData>] = [:]
    public private(set) var readErrors: [String: String] = [:]
    public private(set) var fetchingKeys: Set<String> = []
    public var isLoading: Bool { fetchingKeys.contains { snapshots[$0] == nil } }
    public private(set) var isPreparing = false
    public private(set) var presentationError: String?
    public var presentation: ResearchChartBuilderPresentation? {
        presentationStamp == projectionSignature ? preparedPresentation : nil
    }
    public var seriesMeta: [String: ResearchMeta] { snapshots.mapValues(\.meta) }
    public var searchText = "" { didSet { if searchText != oldValue { queueSearch() } } }
    public private(set) var tickerResults: [ResearchSearchItem] = []
    public private(set) var macroResults: [ResearchMacroSearchItem] = []
    public private(set) var isTickerSearching = false
    public private(set) var isMacroSearching = false
    public private(set) var searchMeta: ResearchMeta?
    public private(set) var macroSearchMeta: ResearchMeta?
    public private(set) var searchError: String?
    public var isSearchOpen: Bool {
        let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && searchedQuery == text
    }
    public var isOnline = true {
        didSet {
            if isOnline != oldValue {
                loadedScope = nil
                queueSearch(debounce: false)
            }
        }
    }
    public private(set) var notice: ScreenNotice?
    public var canUndoDelete: Bool { undoLibrary != nil && undoUntil.map { now() < $0 } == true && !isStorageAction }
    public var shareOrigin: (@MainActor () async throws -> String)?
    public var copyText: (@MainActor (String) async throws -> Void)?
    public var didReplaceRoute: (@MainActor (NativeRoute) -> Void)?
    @ObservationIgnored private let service: any ResearchChartBuilderService
    @ObservationIgnored private let store: any ResearchChartLayoutStore
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let makeID: @Sendable () -> String
    @ObservationIgnored private let debounceNanoseconds: UInt64
    @ObservationIgnored private var readStorageTask: Task<Bool, Never>?
    @ObservationIgnored private var storageReadRevision = UUID()
    @ObservationIgnored private var writeTask: Task<Bool, Never>?
    @ObservationIgnored private var writeSequence = 0
    @ObservationIgnored private var storageFailureShown = false
    @ObservationIgnored private var persistedLibrary: ResearchChartBuilderLibrary?
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var route = NativeRoute(path: "/research/charts")
    @ObservationIgnored private var visitRevision = UUID()
    @ObservationIgnored private var readRevision = UUID()
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var readScope: String?
    @ObservationIgnored private var loadedScope: String?
    @ObservationIgnored private var projectionRevision = UUID()
    @ObservationIgnored private var projectionTask: Task<Void, Never>?
    private var presentationStamp: String?
    private var preparedPresentation: ResearchChartBuilderPresentation?
    @ObservationIgnored private var searchRevision = UUID()
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var searchedQuery: String?
    @ObservationIgnored private var handledShared: String?
    @ObservationIgnored private var pendingSharedState: ResearchChartBuilderState?
    private var undoLibrary: ResearchChartBuilderLibrary?
    private var undoUntil: Date?
    @ObservationIgnored private var undoTask: Task<Void, Never>?
    @ObservationIgnored private var noticeID = 0
    public init(
        service: any ResearchChartBuilderService,
        store: any ResearchChartLayoutStore = ResearchChartLayoutMemoryStore(), cache: ResearchReadCache? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        makeID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }, debounceMilliseconds: Int = 300
    ) {
        self.service = service
        self.store = store
        self.cache = cache ?? ResearchReadCache()
        self.now = now
        self.makeID = makeID
        debounceNanoseconds = UInt64(max(0, debounceMilliseconds)) * 1_000_000
    }
    public convenience init(client: APIClient, store: any ResearchChartLayoutStore = ResearchChartLayoutMemoryStore()) {
        self.init(service: client, store: store)
    }
    private func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now())
    }
    private func signature(_ raw: TaxValue) -> String {
        String(decoding: (try? APIBody.encode(raw)) ?? Data(), as: UTF8.self)
    }
    private func distinctKeys(_ state: ResearchChartBuilderState) -> [String] {
        var seen = Set<String>()
        return state.series.map(\.fetchKey).filter { seen.insert($0).inserted }
    }
    private var distinctSeries: [ResearchChartBuilderSeries] {
        var seen = Set<String>()
        return state.series.filter { seen.insert($0.fetchKey).inserted }
    }
    private var dataScope: String {
        signature(.array([.string(state.range)] + distinctSeries.map { .string($0.fetchKey) }))
    }
    private func seriesCacheKey(_ series: ResearchChartBuilderSeries, range: String) -> String {
        signature(.array([.string("research-chart"), .string(series.fetchKey), .string(range)]))
    }
    public func load(route: NativeRoute, force: Bool = false) async {
        if !isActive {
            isActive = true
            visitRevision = UUID()
        }
        self.route = route
        let visit = visitRevision
        guard await restoreStorage(), isActive, visit == visitRevision, route == self.route, !Task.isCancelled else {
            return
        }
        consumeShared(route)
        await loadSeries(force: force)
    }
    public func retryStorageLoad() async {
        if isStorageLoaded { _ = await queueWrite(library).value } else { await load(route: route) }
    }
    private func restoreStorage() async -> Bool {
        if isStorageLoaded { return true }
        if let task = readStorageTask { return await task.value }
        storageStatus = .loading
        storageError = nil
        let revision = UUID()
        storageReadRevision = revision
        let visit = visitRevision
        let task = Task { [self] in
            do {
                _ = await writeTask?.value
                guard revision == storageReadRevision, visit == visitRevision, isActive, !Task.isCancelled else {
                    return false
                }
                let data = try await store.read()
                guard revision == storageReadRevision, visit == visitRevision, isActive, !Task.isCancelled else {
                    return false
                }
                let old = state
                library = ResearchChartLayoutCodec.load(data)
                isStorageLoaded = true
                stateChanged(from: old, schedule: false)
                storageError = nil
                _ = queueWrite(library)
                return true
            } catch {
                guard revision == storageReadRevision, visit == visitRevision, isActive else { return false }
                storageError = error.localizedDescription
                storageStatus = .failed
                showStorageFailure()
                return false
            }
        }
        readStorageTask = task
        let result = await task.value
        if revision == storageReadRevision { readStorageTask = nil }
        return result
    }
    private func queueWrite(_ snapshot: ResearchChartBuilderLibrary) -> Task<Bool, Never> {
        let previous = writeTask
        let authorized = isStorageLoaded
        writeSequence += 1
        let sequence = writeSequence
        storageStatus = .saving
        let task = Task { [self] in
            _ = await previous?.value
            guard authorized, let data = try? ResearchChartLayoutCodec.save(snapshot) else {
                acknowledgeWrite(snapshot: snapshot, sequence: sequence, success: false)
                return false
            }
            let success = await store.write(data)
            acknowledgeWrite(snapshot: snapshot, sequence: sequence, success: success)
            return success
        }
        writeTask = task
        return task
    }
    private func acknowledgeWrite(snapshot: ResearchChartBuilderLibrary, sequence: Int, success: Bool) {
        if success {
            persistedLibrary = snapshot
            storageFailureShown = false
        }
        if sequence == writeSequence {
            storageStatus = success ? (library == snapshot ? .saved : .saving) : .failed
            storageError = success ? nil : "research.builder.storageFailed"
            if !success { showStorageFailure() }
        }
    }
    private func showStorageFailure() {
        if !storageFailureShown {
            storageFailureShown = true
            showNotice("research.builder.storageFailed", kind: .error)
        }
    }
    public func flushStorage() async { _ = await writeTask?.value }
    public func selectLayout(id: String?) {
        guard canEdit, id == nil || library.layouts.contains(where: { $0.id == id }) else { return }
        let old = state
        library.activeLayoutId = id
        _ = queueWrite(library)
        stateChanged(from: old)
    }
    public func addSeries(symbol: String) {
        guard state.series.count < 5 else { return }
        var state = state
        let id = makeID()
        state.series.append(.init(id: id, symbol: symbol.uppercased()))
        state.oscillatorSeriesId = state.oscillatorSeriesId ?? id
        self.state = state
        searchText = ""
    }
    public func addMacro(item: ResearchMacroSearchItem) {
        guard state.series.count < 5 else { return }
        var state = state
        let id = makeID()
        state.series.append(
            .init(
                id: id, symbol: item.seriesId, provider: item.provider,
                macro: .init(provider: item.provider, seriesId: item.seriesId, title: item.title)))
        state.oscillatorSeriesId = state.oscillatorSeriesId ?? id
        self.state = state
        searchText = ""
    }
    public func updateSeries(id: String, patch: (inout ResearchChartBuilderSeries) -> Void) {
        var state = state
        guard let index = state.series.firstIndex(where: { $0.id == id }) else { return }
        patch(&state.series[index])
        self.state = state
    }
    public func removeSeries(id: String) {
        var state = state
        state.series.removeAll { $0.id == id }
        state.indicators.removeAll { $0.seriesId == id }
        if state.oscillatorSeriesId == id { state.oscillatorSeriesId = nil }
        self.state = state
    }
    public func addIndicator(type: String) {
        guard state.indicators.count < 20, let base = state.series.first(where: { $0.field == "price" }) else { return }
        var state = state
        state.indicators.append(
            .init(
                id: makeID(), type: type, period: type == "bollinger" ? 20 : type == "ema" ? 12 : 50, seriesId: base.id)
        )
        self.state = state
    }
    public func updateIndicator(id: String, patch: (inout ResearchChartBuilderIndicator) -> Void) {
        var state = state
        guard let index = state.indicators.firstIndex(where: { $0.id == id }) else { return }
        patch(&state.indicators[index])
        self.state = state
    }
    public func setIndicatorPeriod(id: String, raw: String) {
        // A structural count uses the same Number coercion as the web number input.
        // Monetary input and statistical computation never pass through Double here.
        let value = Double(raw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 2
        let period = max(2, value == 0 || value.isNaN ? 2 : value)
        guard period.isFinite, period.rounded(.towardZero) == period, period <= 500 else { return }
        updateIndicator(id: id) { $0.period = Int(period) }
    }
    public func removeIndicator(id: String) {
        var state = state
        state.indicators.removeAll { $0.id == id }
        self.state = state
    }
    public func preset(_ preset: String) {
        guard let primary = state.series.first(where: { $0.field == "price" }) else { return }
        var next = state
        let priceOnly = state.series.filter { $0.field == "price" }
        switch preset {
        case "priceVolume":
            guard let base = priceOnly.first(where: { $0.macro == nil }) else { return }
            next.series =
                priceOnly.map {
                    var series = $0
                    series.type = "line"
                    return series
                } + [
                    .init(
                        id: makeID(), symbol: base.symbol, field: "volume", type: "bar", axis: "right",
                        provider: base.provider)
                ]
            next.indicators = []
            next.oscillator = "none"
        case "sma", "bollinger":
            next.series = priceOnly.map {
                var series = $0
                series.type = "line"
                return series
            }
            next.oscillator = "none"
            next.indicators =
                preset == "sma"
                ? [
                    .init(id: makeID(), type: "sma", period: 50, seriesId: primary.id),
                    .init(id: makeID(), type: "sma", period: 200, seriesId: primary.id),
                ] : [.init(id: makeID(), type: "bollinger", period: 20, seriesId: primary.id)]
        case "rsi", "macd":
            next.oscillator = preset
            next.oscillatorSeriesId = primary.id
        case "rebased":
            next.rebase = true
            next.series = priceOnly.map {
                var series = $0
                series.type = "line"
                series.axis = "left"
                return series
            }
        default: return
        }
        state = next
    }
    public func requestNew() {
        guard canEdit else { return }
        if activeLayout == nil, state == .default { startNew() } else { pendingConfirmation = .new }
    }
    private func startNew() {
        let old = state
        library.activeLayoutId = nil
        library.draft = .default
        pendingConfirmation = nil
        _ = queueWrite(library)
        stateChanged(from: old)
    }
    private func consumeShared(_ route: NativeRoute) {
        guard let encoded = route.value("chart") else {
            handledShared = nil
            return
        }
        guard handledShared != encoded else { return }
        handledShared = encoded
        if let imported = ResearchChartLayoutCodec.decodeShared(encoded) {
            if library.draft == .default {
                applyShared(imported)
            } else {
                pendingSharedState = imported
                pendingConfirmation = .share
            }
        } else {
            showNotice("research.builder.shareInvalid", kind: .error)
        }
        self.route = route.removing("chart")
        didReplaceRoute?(self.route)
    }
    private func applyShared(_ imported: ResearchChartBuilderState) {
        let old = state
        library.activeLayoutId = nil
        library.draft = imported
        pendingSharedState = nil
        pendingConfirmation = nil
        _ = queueWrite(library)
        stateChanged(from: old)
        showNotice("research.builder.shareImported")
    }
    public func confirmPending() {
        guard canEdit else { return }
        switch pendingConfirmation {
        case .new: startNew()
        case .share: if let state = pendingSharedState { applyShared(state) }
        case nil: break
        }
    }
    public func cancelPending() {
        pendingConfirmation = nil
        pendingSharedState = nil
    }
    @discardableResult public func saveAs() async -> Bool {
        guard canEdit else { return false }
        let name = layoutName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            showNotice("research.builder.saveError.empty", kind: .error)
            return false
        }
        guard library.layouts.count < 20 else {
            showNotice("research.builder.saveError.limit", kind: .error)
            return false
        }
        guard
            !library.layouts.contains(where: {
                $0.name.lowercased(with: Locale.current) == name.lowercased(with: Locale.current)
            })
        else {
            showNotice("research.builder.saveError.duplicate", kind: .error)
            return false
        }
        var next = library
        let id = makeID()
        let timestamp = timestamp()
        next.activeLayoutId = id
        next.layouts.append(.init(id: id, name: name, state: state, createdAt: timestamp, updatedAt: timestamp))
        guard (try? next.validate()) != nil else {
            showNotice("research.builder.saveError.invalid", kind: .error)
            return false
        }
        isStorageAction = true
        defer { isStorageAction = false }
        let visit = visitRevision
        guard await queueWrite(next).value else {
            if visit == visitRevision { isStorageLoaded = false }
            return false
        }
        guard isActive, visit == visitRevision else { return true }
        library = next
        storageStatus = .saved
        layoutName = ""
        isSaveDialogPresented = false
        showNotice("research.builder.layoutSaved")
        return true
    }
    @discardableResult public func deleteLayout() async -> Bool {
        guard canEdit, let id = library.activeLayoutId else { return false }
        let previous = library
        var next = library
        next.activeLayoutId = nil
        next.layouts.removeAll { $0.id == id }
        isStorageAction = true
        defer { isStorageAction = false }
        let visit = visitRevision
        guard await queueWrite(next).value else {
            if visit == visitRevision { isStorageLoaded = false }
            return false
        }
        guard isActive, visit == visitRevision else { return true }
        let old = state
        library = next
        storageStatus = .saved
        stateChanged(from: old)
        undoLibrary = previous
        undoUntil = now().addingTimeInterval(8)
        undoTask?.cancel()
        undoTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            self?.undoLibrary = nil
            self?.undoUntil = nil
        }
        showNotice("research.builder.layoutDeleted")
        return true
    }
    @discardableResult public func undoDelete() async -> Bool {
        guard canEdit, canUndoDelete, let previous = undoLibrary else { return false }
        isStorageAction = true
        defer { isStorageAction = false }
        let visit = visitRevision
        guard await queueWrite(previous).value else {
            if visit == visitRevision { isStorageLoaded = false }
            return false
        }
        guard isActive, visit == visitRevision else { return true }
        let old = state
        library = previous
        storageStatus = .saved
        undoLibrary = nil
        undoUntil = nil
        undoTask?.cancel()
        stateChanged(from: old)
        return true
    }
    public func copyShareLink() async {
        guard isStorageLoaded else { return }
        do {
            guard let shareOrigin, let copyText else { throw APIError.backendUnavailable }
            let encoded = try ResearchChartLayoutCodec.encodeShared(state)
            let shared = route.setting("chart", to: encoded)
            let origin = try await shareOrigin().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let url = URL(string: origin + shared.string), ["http", "https"].contains(url.scheme ?? ""),
                url.host != nil
            else { throw APIError.invalidRequest("Invalid chart share origin") }
            try await copyText(url.absoluteString)
            showNotice("research.builder.shareCopied")
        } catch { showNotice("research.builder.shareFailed", kind: .error) }
    }
    private func showNotice(_ key: String, kind: ScreenNotice.Kind = .success) {
        noticeID += 1
        notice = .init(id: noticeID, kind: kind, key: key)
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    private func stateChanged(from old: ResearchChartBuilderState, schedule: Bool = true) {
        projectionRevision = UUID()
        projectionTask?.cancel()
        isPreparing = false
        presentationError = nil
        let oldKeys = signature(.array([.string(old.range)] + distinctKeys(old).map(TaxValue.string)))
        let newKeys = signature(.array([.string(state.range)] + distinctKeys(state).map(TaxValue.string)))
        if oldKeys != newKeys {
            readRevision = UUID()
            readTask?.cancel()
            readTask = nil
            readScope = nil
            loadedScope = nil
            fetchingKeys = []
            if old.range != state.range {
                snapshots = [:]
                readErrors = [:]
            } else {
                let keys = Set(state.series.map(\.fetchKey))
                snapshots = snapshots.filter { keys.contains($0.key) }
                readErrors = readErrors.filter { keys.contains($0.key) }
            }
            if schedule && isActive { readTask = Task { [weak self] in await self?.loadSeries() } }
        } else if schedule && isActive {
            scheduleProjection()
        }
    }
    public func loadSeries(force: Bool = false) async {
        guard isActive, isStorageLoaded else { return }
        let scope = dataScope
        if readScope == scope, let task = readTask, !force {
            await task.value
            return
        }
        if loadedScope == scope, !force {
            await preparePresentation()
            return
        }
        readScope = scope
        let revision = UUID()
        readRevision = revision
        let series = distinctSeries
        let range = state.range
        let service = service
        let cache = cache
        let online = isOnline
        fetchingKeys = online ? Set(series.map(\.fetchKey)) : []
        let task = Task { [weak self] in
            guard let self else { return }
            await withTaskGroup(of: SeriesResult.self) { group in
                for item in series {
                    let key = seriesCacheKey(item, range: range)
                    group.addTask {
                        do {
                            if let macro = item.macro {
                                let response: ResearchSnapshot<ResearchMacroSeriesData>
                                if online {
                                    response = try await cache.request(key: key, freshFor: 60, force: force) {
                                        try await service.researchMacroSeries(
                                            provider: macro.provider, seriesId: macro.seriesId, range: range)
                                    }
                                } else if let cached = await cache.cached(
                                    key: key, as: ResearchSnapshot<ResearchMacroSeriesData>.self)
                                {
                                    response = cached
                                } else {
                                    return .unavailable(item.fetchKey)
                                }
                                return .success(
                                    item.fetchKey, .init(data: try response.data.chart, meta: response.meta))
                            }
                            let response: ResearchSnapshot<ResearchChartData>
                            if online {
                                response = try await cache.request(key: key, freshFor: 60, force: force) {
                                    try await service.researchChart(
                                        symbol: item.symbol, range: range, assetClass: nil,
                                        provider: item.provider.isEmpty ? nil : item.provider)
                                }
                            } else if let cached = await cache.cached(
                                key: key, as: ResearchSnapshot<ResearchChartData>.self)
                            {
                                response = cached
                            } else {
                                return .unavailable(item.fetchKey)
                            }
                            return .success(item.fetchKey, response)
                        } catch { return .failure(item.fetchKey, error.localizedDescription) }
                    }
                }
                for await result in group {
                    guard revision == readRevision, scope == dataScope, isActive, !Task.isCancelled else { continue }
                    switch result {
                    case .success(let key, let snapshot):
                        snapshots[key] = snapshot
                        readErrors[key] = nil
                        fetchingKeys.remove(key)
                    case .failure(let key, let error):
                        readErrors[key] = error
                        fetchingKeys.remove(key)
                    case .unavailable(let key): fetchingKeys.remove(key)
                    }
                }
            }
            guard revision == readRevision, scope == dataScope, isActive, !Task.isCancelled else { return }
            fetchingKeys = []
            loadedScope = scope
            readTask = nil
            await preparePresentation()
        }
        readTask = task
        await task.value
    }
    private enum SeriesResult: Sendable {
        case success(String, ResearchSnapshot<ResearchChartData>)
        case failure(String, String)
        case unavailable(String)
    }
    public func presentationInput() -> TaxValue {
        .object([
            "kind": .string("chart"),
            "series": .array(
                state.series.map { series in
                    .object([
                        "id": .string(series.id), "field": .string(series.field), "type": .string(series.type),
                        "points": .array((snapshots[series.fetchKey]?.data.points ?? []).map(\.raw)),
                    ])
                }), "indicators": .array(state.indicators.map(\.raw)), "rebase": .bool(state.rebase),
            "oscillator": .string(state.oscillator),
            "oscillatorSeriesId": state.oscillatorSeriesId.map(TaxValue.string) ?? .null,
        ])
    }
    private var projectionSignature: String { signature(presentationInput()) }
    private func scheduleProjection() {
        projectionTask = Task { [weak self] in
            await Task.yield()
            await self?.preparePresentation()
        }
    }
    private func preparePresentation() async {
        guard isActive, !state.series.isEmpty, isOnline else {
            if state.series.isEmpty {
                preparedPresentation = nil
                presentationStamp = nil
            }
            return
        }
        let input = presentationInput()
        let stamp = signature(input)
        guard preparedPresentation == nil || presentationStamp != stamp else { return }
        let revision = UUID()
        projectionRevision = revision
        isPreparing = true
        presentationError = nil
        defer { if revision == projectionRevision { isPreparing = false } }
        do {
            let value = try await service.researchPresentation(input)
            guard revision == projectionRevision, stamp == projectionSignature, isActive, !Task.isCancelled else {
                return
            }
            preparedPresentation = try .init(raw: value)
            presentationStamp = stamp
        } catch {
            if revision == projectionRevision, stamp == projectionSignature, isActive {
                presentationError = error.localizedDescription
            }
        }
    }
    private func queueSearch(debounce: Bool = true) {
        searchRevision = UUID()
        searchTask?.cancel()
        isTickerSearching = false
        isMacroSearching = false
        tickerResults = []
        macroResults = []
        searchMeta = nil
        macroSearchMeta = nil
        searchError = nil
        searchedQuery = nil
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, isActive else { return }
        let revision = searchRevision
        searchTask = Task { [weak self] in
            guard let self else { return }
            do { if debounce { try await Task.sleep(nanoseconds: debounceNanoseconds) } } catch { return }
            guard revision == searchRevision, query == searchText.trimmingCharacters(in: .whitespacesAndNewlines),
                isActive
            else { return }
            searchedQuery = query
            isTickerSearching = isOnline
            isMacroSearching = isOnline
            async let ticker: Void = searchTicker(query: query, revision: revision)
            async let macro: Void = searchMacro(query: query, revision: revision)
            _ = await (ticker, macro)
        }
    }
    private func searchTicker(query: String, revision: UUID) async {
        defer { if revision == searchRevision { isTickerSearching = false } }
        do {
            let key = ResearchReadKey.search(source: .research, query: query)
            let result: ResearchSnapshot<ResearchSearchData>
            let service = service
            if isOnline {
                result = try await cache.request(key: key, freshFor: 60) {
                    try await service.researchSearch(query: query)
                }
            } else if let cached = cache.cached(key: key, as: ResearchSnapshot<ResearchSearchData>.self) {
                result = cached
            } else {
                return
            }
            guard revision == searchRevision, isActive else { return }
            tickerResults = result.data.items
            searchMeta = result.meta
        } catch { if revision == searchRevision, isActive { searchError = error.localizedDescription } }
    }
    private func searchMacro(query: String, revision: UUID) async {
        defer { if revision == searchRevision { isMacroSearching = false } }
        do {
            let key = signature(.array([.string("macro-search"), .string(query)]))
            let result: ResearchSnapshot<ResearchMacroSearchData>
            let service = service
            if isOnline {
                result = try await cache.request(key: key, freshFor: 60) {
                    try await service.researchMacroSearch(query: query)
                }
            } else if let cached = cache.cached(key: key, as: ResearchSnapshot<ResearchMacroSearchData>.self) {
                result = cached
            } else {
                return
            }
            guard revision == searchRevision, isActive else { return }
            macroResults = result.data.items
            macroSearchMeta = result.meta
        } catch { if revision == searchRevision, isActive { searchError = error.localizedDescription } }
    }
    public func didDisappear() {
        isActive = false
        isStorageLoaded = false
        visitRevision = UUID()
        storageReadRevision = UUID()
        readStorageTask?.cancel()
        readStorageTask = nil
        readRevision = UUID()
        readTask?.cancel()
        readTask = nil
        readScope = nil
        loadedScope = nil
        fetchingKeys = []
        projectionRevision = UUID()
        projectionTask?.cancel()
        projectionTask = nil
        isPreparing = false
        searchRevision = UUID()
        searchTask?.cancel()
        searchTask = nil
        searchText = ""
        tickerResults = []
        macroResults = []
        isTickerSearching = false
        isMacroSearching = false
        searchedQuery = nil
        isSaveDialogPresented = false
        layoutName = ""
        pendingConfirmation = nil
        pendingSharedState = nil
        handledShared = nil
    }
    public func invalidate() {
        for series in distinctSeries { cache.invalidate(key: seriesCacheKey(series, range: state.range)) }
        readRevision = UUID()
        readTask?.cancel()
        readTask = nil
        readScope = nil
        loadedScope = nil
        fetchingKeys = []
        projectionRevision = UUID()
        projectionTask?.cancel()
        isPreparing = false
    }
}
