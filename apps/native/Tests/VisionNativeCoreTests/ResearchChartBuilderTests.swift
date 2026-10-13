import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native Chart Builder state, storage and server projections")
struct ResearchChartBuilderTests {
    @Test func portableStatesRejectUnknownsDuplicateIdsDanglingRefsAndInvalidPeriods() throws {
        let original = chartTestState()
        #expect(try ResearchChartBuilderState(raw: original.raw) == original)
        var unknown = original.raw
        unknown["rows"] = .array([])
        #expect(throws: APIError.self) { try ResearchChartBuilderState(raw: unknown) }
        var duplicate = original
        duplicate.series.append(duplicate.series[0])
        #expect(throws: APIError.self) { try duplicate.validate() }
        var dangling = original
        dangling.indicators = [.init(id: "i", type: "sma", period: 1, seriesId: "absent")]
        #expect(throws: APIError.self) { try dangling.validate() }
        var legal = original
        legal.indicators = [.init(id: "i", type: "sma", period: 1, seriesId: original.series[0].id)]
        #expect(try ResearchChartBuilderState(raw: legal.raw).indicators[0].period == 1)
        legal.indicators[0].period = 501
        #expect(throws: APIError.self) { try legal.validate() }
        for range in ["1d", "5d", "2y", "max"] {
            var state = original
            state.range = range
            try state.validate()
        }
    }
    @Test func libraryGoldenSchemaNameFoldingStrictnessAndMissingActiveReferencesMatchWeb() throws {
        let raw = Data(
            #"{"version":2,"activeLayoutId":"saved","draft":{"range":"1y","logLeft":false,"rebase":false,"series":[],"indicators":[],"oscillator":"none","oscillatorSeriesId":null},"layouts":[{"id":"saved","name":"  Synthetic  ","state":{"range":"max","logLeft":true,"rebase":false,"series":[],"indicators":[],"oscillator":"none","oscillatorSeriesId":null},"createdAt":"created","updatedAt":"updated"}]}"#
                .utf8)
        let library = ResearchChartLayoutCodec.load(raw)
        #expect(library.activeLayout?.name == "Synthetic")
        #expect(library.activeState.range == "max")
        let encoded = try JSONDecoder().decode(TaxValue.self, from: ResearchChartLayoutCodec.save(library))
        #expect(encoded["version"] == .number(2))
        #expect(encoded["draft"]?["oscillatorSeriesId"] == .null)
        #expect(encoded["layouts"]?.arrayValue?[0]["name"] == .string("Synthetic"))
        var duplicate = library
        var other = duplicate.layouts[0]
        other.id = "other"
        other.name = "SYNTHETIC"
        duplicate.layouts.append(other)
        #expect(throws: APIError.self) { try duplicate.validate() }
        var missing = library
        missing.activeLayoutId = "missing"
        #expect(throws: APIError.self) { try missing.validate() }
        var unknown = library.raw
        unknown["legacy"] = .bool(true)
        #expect(ResearchChartLayoutCodec.load(try APIBody.encode(unknown)) == .empty)
    }
    @Test func utf16LoadBoundAndUtf8WriteBoundRemainDistinctWithoutSavingChartRows() throws {
        let state = chartLargeUnicodeState()
        try state.validate()
        let layouts = (0..<20).map {
            ResearchChartBuilderLayout(
                id: "layout-\($0)", name: "Layout \($0)", state: state, createdAt: "", updatedAt: "")
        }
        let library = ResearchChartBuilderLibrary(layouts: layouts)
        let bytes = try APIBody.encode(library)
        #expect(bytes.count > 250_000)
        #expect(String(decoding: bytes, as: UTF8.self).utf16.count <= 250_000)
        #expect(ResearchChartLayoutCodec.load(bytes).layouts.count == 20)
        #expect(throws: APIError.self) { try ResearchChartLayoutCodec.save(library) }
        #expect(throws: APIError.self) { try ResearchChartLayoutCodec.encodeShared(state) }
        #expect(!String(decoding: bytes, as: UTF8.self).contains("\"points\""))
        #expect(!String(decoding: bytes, as: UTF8.self).contains("\"rows\""))
    }
    @Test func sharedUrlsDecodeExactVersionOneStateAndRejectWrongShapeOrOversize() throws {
        let original = chartTestState()
        let encoded = try ResearchChartLayoutCodec.encodeShared(original)
        #expect(ResearchChartLayoutCodec.decodeShared(encoded) == original)
        #expect(!encoded.contains("="))
        let other = try APIBody.encode(TaxValue.object(["version": .number(2), "state": original.raw]))
            .base64EncodedString()
        #expect(ResearchChartLayoutCodec.decodeShared(other) == nil)
        #expect(ResearchChartLayoutCodec.decodeShared(String(repeating: "a", count: 20_001)) == nil)
    }
    @Test func failedInitialReadCannotOverwriteExistingLayoutsAndRetryRestoresAuthority() async throws {
        let library = ResearchChartBuilderLibrary(draft: chartTestState())
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(library))
        store.readFails = true
        let transport = ChartTestTransport()
        let model = chartTestModel(transport, store: store)
        await model.load(route: chartTestRoute)
        #expect(!model.isStorageLoaded)
        #expect(model.storageStatus == .failed)
        model.state = .default
        model.layoutName = "Cannot save"
        #expect(await model.saveAs() == false)
        #expect(store.writes.isEmpty)
        store.readFails = false
        await model.retryStorageLoad()
        await model.flushStorage()
        #expect(model.state == library.draft)
        #expect(model.storageStatus == .saved)
        #expect(ResearchChartLayoutCodec.load(store.data) == library)
    }
    @Test func leaveDuringInitialReadNeverWritesOldSnapshotAndReentryReadsNewWebState() async throws {
        let old = ResearchChartBuilderLibrary(draft: chartTestState())
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(old))
        store.pauseRead = true
        let transport = ChartTestTransport()
        let model = chartTestModel(transport, store: store)
        let entering = Task { await model.load(route: chartTestRoute) }
        await store.waitForRead()
        model.didDisappear()
        var updated = old
        updated.draft.range = "3mo"
        store.data = try ResearchChartLayoutCodec.save(updated)
        store.releaseRead()
        await entering.value
        #expect(store.writes.isEmpty)
        #expect(!model.isStorageLoaded)
        #expect(await transport.requests.isEmpty)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        #expect(model.state.range == "3mo")
        #expect(ResearchChartLayoutCodec.load(store.data) == updated)
    }
    @Test func autosavesSerializeAndAcknowledgeOnlyLatestConcreteLibraryWithoutBlockingEdits() async throws {
        let store = ChartTestStore()
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        store.pauseWrite = true
        var state = model.state
        state.range = "3mo"
        model.state = state
        await store.waitForWrite()
        state.range = "6mo"
        model.state = state
        #expect(model.canEdit)
        #expect(store.writes.count == 2)
        model.didDisappear()
        store.releaseWrite()
        await model.flushStorage()
        #expect(store.writes.count == 3)
        #expect(ResearchChartLayoutCodec.load(store.writes[1]).draft.range == "3mo")
        #expect(ResearchChartLayoutCodec.load(store.data).draft.range == "6mo")
        #expect(model.storageStatus == .saved)
    }
    @Test func actualReentryReadsChangedWebLibraryBeforeAnyNewAutosave() async throws {
        let original = ResearchChartBuilderLibrary(draft: chartTestState())
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(original))
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        model.didDisappear()
        var changedByWeb = original
        changedByWeb.draft.range = "5y"
        changedByWeb.draft.series[0].symbol = "WEB.NEW"
        store.data = try ResearchChartLayoutCodec.save(changedByWeb)
        let previousWrites = store.writes.count
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        #expect(store.reads == 2)
        #expect(model.state == changedByWeb.draft)
        #expect(store.writes.count == previousWrites + 1)
        #expect(ResearchChartLayoutCodec.load(store.writes.last) == changedByWeb)
    }
    @Test func saveAsRequiresAcknowledgementAndFailureKeepsConcreteDraftAndName() async throws {
        let store = ChartTestStore()
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        var state = model.state
        state.range = "5y"
        model.state = state
        await model.flushStorage()
        model.layoutName = "  Synthetic saved  "
        model.isSaveDialogPresented = true
        store.writeSucceeds = false
        #expect(await model.saveAs() == false)
        #expect(model.library.layouts.isEmpty)
        #expect(model.layoutName == "  Synthetic saved  ")
        #expect(model.isSaveDialogPresented)
        store.writeSucceeds = true
        await model.retryStorageLoad()
        #expect(await model.saveAs())
        #expect(model.activeLayout?.name == "Synthetic saved")
        #expect(model.state.range == "5y")
        #expect(model.activeLayout?.createdAt == "2026-01-01T00:00:00.000Z")
        #expect(ResearchChartLayoutCodec.load(store.data) == model.library)
    }
    @Test func unknownExplicitWriteAcknowledgementReadsCommittedLibraryBeforeRetrying() async throws {
        let store = ChartTestStore()
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        model.layoutName = "Committed without acknowledgement"
        store.commitFailedWrites = true
        store.writeSucceeds = false
        #expect(await model.saveAs() == false)
        #expect(!model.canEdit)
        #expect(model.library.layouts.isEmpty)
        #expect(ResearchChartLayoutCodec.load(store.data).layouts.first?.name == model.layoutName)
        store.writeSucceeds = true
        await model.retryStorageLoad()
        await model.flushStorage()
        #expect(model.activeLayout?.name == "Committed without acknowledgement")
        #expect(ResearchChartLayoutCodec.load(store.data).layouts.count == 1)
    }
    @Test func saveAcknowledgementAfterLeavingCannotRestoreOldPageOrClearNewDialog() async throws {
        let store = ChartTestStore()
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        model.layoutName = "Saved before leave"
        store.pauseWrite = true
        let saving = Task { await model.saveAs() }
        await store.waitForWrite()
        model.didDisappear()
        model.layoutName = "New dialog"
        model.isSaveDialogPresented = true
        store.releaseWrite()
        #expect(await saving.value)
        #expect(model.library.layouts.isEmpty)
        #expect(model.layoutName == "New dialog")
        #expect(model.isSaveDialogPresented)
        #expect(ResearchChartLayoutCodec.load(store.data).layouts.first?.name == "Saved before leave")
        await model.load(route: chartTestRoute)
        #expect(model.activeLayout?.name == "Saved before leave")
    }
    @Test func deleteUndoRestoresExactLibraryOnceAndFailedAcknowledgementKeepsUndoUntilExpiry() async throws {
        let clock = ChartTestClock()
        let store = ChartTestStore()
        let model = chartTestModel(ChartTestTransport(), store: store, clock: clock)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        model.layoutName = "Synthetic"
        #expect(await model.saveAs())
        let previous = model.library
        #expect(await model.deleteLayout())
        #expect(model.canUndoDelete)
        #expect(model.library.layouts.isEmpty)
        store.writeSucceeds = false
        #expect(await model.undoDelete() == false)
        #expect(model.canUndoDelete)
        store.writeSucceeds = true
        await model.retryStorageLoad()
        #expect(await model.undoDelete())
        #expect(model.library == previous)
        #expect(!model.canUndoDelete)
        #expect(await model.undoDelete() == false)
        #expect(await model.deleteLayout())
        clock.advance(9)
        #expect(!model.canUndoDelete)
    }
    @Test func sharesConfirmUnnamedDraftReplacementAndRemoveOnlyChartQuery() async throws {
        let library = ResearchChartBuilderLibrary(draft: chartTestState())
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(library))
        let model = chartTestModel(ChartTestTransport(), store: store)
        await model.load(route: chartTestRoute)
        var imported = chartTestState()
        imported.range = "3mo"
        let encoded = try ResearchChartLayoutCodec.encodeShared(imported)
        var replaced: NativeRoute?
        model.didReplaceRoute = { replaced = $0 }
        await model.load(
            route: NativeRoute(
                path: "/research/charts",
                query: [.init(name: "keep", value: "value"), .init(name: "chart", value: encoded)]))
        #expect(model.pendingConfirmation == .share)
        #expect(model.state == library.draft)
        #expect(replaced?.value("chart") == nil)
        #expect(replaced?.value("keep") == "value")
        model.confirmPending()
        await model.flushStorage()
        #expect(model.state == imported)
        #expect(model.library.activeLayoutId == nil)
        model.layoutName = "Named"
        #expect(await model.saveAs())
        model.requestNew()
        #expect(model.pendingConfirmation == .new)
        model.confirmPending()
        #expect(model.state == .default)
        #expect(model.library.layouts.count == 1)
    }
    @Test func shareCopyCapturesCurrentLibraryKeepsOtherParametersAndUsesAppOrigin() async throws {
        let model = chartTestModel(ChartTestTransport(), store: ChartTestStore())
        await model.load(route: NativeRoute(path: "/research/charts", query: [.init(name: "keep", value: "opaque")]))
        var copied: String?
        model.shareOrigin = { "http://localhost:54321" }
        model.copyText = { copied = $0 }
        await model.copyShareLink()
        let url = try #require(copied.flatMap(URL.init(string:)))
        #expect(url.host == "localhost")
        #expect(url.port == 54321)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.first { $0.name == "keep" }?.value == "opaque")
        let shared = try #require(items.first { $0.name == "chart" }?.value)
        #expect(ResearchChartLayoutCodec.decodeShared(shared) == model.state)
    }
    @Test func presetsAndNumberPeriodEditsPreserveExactStructuralSemantics() async throws {
        let model = chartTestModel(ChartTestTransport(), store: ChartTestStore())
        await model.load(route: chartTestRoute)
        var state = chartTestState()
        state.series = (0..<5).map { .init(id: "s\($0)", symbol: "S\($0)") }
        state.oscillatorSeriesId = "s0"
        model.state = state
        model.preset("priceVolume")
        #expect(model.state == state)
        model.addIndicator(type: "ema")
        let indicator = try #require(model.state.indicators.first)
        #expect(indicator.period == 12)
        model.setIndicatorPeriod(id: indicator.id, raw: "2e2")
        #expect(model.state.indicators[0].period == 200)
        model.setIndicatorPeriod(id: indicator.id, raw: "20.5")
        #expect(model.state.indicators[0].period == 200)
        model.setIndicatorPeriod(id: indicator.id, raw: "501")
        #expect(model.state.indicators[0].period == 200)
        model.setIndicatorPeriod(id: indicator.id, raw: "1e999")
        #expect(model.state.indicators[0].period == 200)
        model.setIndicatorPeriod(id: indicator.id, raw: "")
        #expect(model.state.indicators[0].period == 2)
        model.removeSeries(id: "s0")
        #expect(model.state.indicators.isEmpty)
        #expect(model.state.oscillatorSeriesId == nil)
    }
    @Test func priceVolumeDeduplicatesProviderReadsAndStyleUpdatesDoNotFetchAgain() async throws {
        let transport = ChartTestTransport()
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: chartTestState())))
        let model = chartTestModel(transport, store: store)
        await model.load(route: chartTestRoute)
        #expect(await transport.chartReads == 1)
        model.preset("priceVolume")
        await model.loadSeries()
        #expect(model.state.series.count == 2)
        #expect(await transport.chartReads == 1)
        let before = await transport.chartReads
        model.updateSeries(id: model.state.series[0].id) {
            $0.axis = "right"
            $0.type = "area"
        }
        var state = model.state
        state.logLeft = true
        model.state = state
        await model.loadSeries()
        #expect(await transport.chartReads == before)
        #expect(model.presentation?.raw["result"]?["rows"]?.arrayValue?[0][model.state.series[0].id] == .number(77))
    }
    @Test func duplicateDisplaySeriesDoNotRefetchAnExpiredProviderCacheUntilActualReentry() async throws {
        let clock = ChartTestClock()
        let transport = ChartTestTransport()
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: chartTestState())))
        let model = chartTestModel(transport, store: store, clock: clock)
        await model.load(route: chartTestRoute)
        await model.flushStorage()
        clock.advance(61)
        model.preset("priceVolume")
        await model.loadSeries()
        #expect(model.state.series.count == 2)
        #expect(await transport.chartReads == 1)
        model.removeSeries(id: model.state.series[1].id)
        await model.loadSeries()
        #expect(await transport.chartReads == 1)
        await model.flushStorage()
        model.didDisappear()
        await model.load(route: chartTestRoute)
        #expect(await transport.chartReads == 2)
    }
    @Test func reconnectLoadsCurrentScopeAfterOfflineEntryWithoutStartingHiddenProviderReads() async throws {
        let transport = ChartTestTransport()
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: chartTestState())))
        let model = chartTestModel(transport, store: store)
        model.isOnline = false
        await model.load(route: chartTestRoute)
        #expect(await transport.chartReads == 0)
        model.isOnline = true
        await model.load(route: chartTestRoute)
        #expect(await transport.chartReads == 1)
        #expect(model.presentation != nil)
        model.didDisappear()
        model.isOnline = false
        model.isOnline = true
        await Task.yield()
        #expect(await transport.chartReads == 1)
    }
    @Test func macroRequestsStayProviderPinnedKeepNullPointsAndUseImportedRanges() async throws {
        var state = ResearchChartBuilderState(range: "2y")
        state.series = [
            .init(
                id: "macro", symbol: "TEST.ID", provider: "fred",
                macro: .init(provider: "fred", seriesId: "TEST.ID", title: "Synthetic macro"))
        ]
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: state)))
        let transport = ChartTestTransport()
        let model = chartTestModel(transport, store: store)
        await model.load(route: chartTestRoute)
        #expect(await transport.chartReads == 0)
        let request = try #require(await transport.requests.first { $0.url.path == "/api/research/macro/series" })
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.first { $0.name == "provider" }?.value == "fred")
        #expect(query.first { $0.name == "series_id" }?.value == "TEST.ID")
        #expect(query.first { $0.name == "range" }?.value == "2y")
        let snapshot = try #require(model.snapshots["m|fred|TEST.ID"])
        #expect(snapshot.data.points[0].close == nil)
        #expect(snapshot.data.raw["units"] == .string("Index"))
        #expect(snapshot.meta.provider == "fred")
    }
    @Test func lateOldRangeAndProjectionCannotReplaceCurrentDataOrHideNewInput() async throws {
        let transport = ChartTestTransport()
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: chartTestState())))
        let model = chartTestModel(transport, store: store)
        await transport.pause(path: "/api/research/chart")
        let entering = Task { await model.load(route: chartTestRoute) }
        await transport.waitForPause()
        var state = model.state
        state.range = "3mo"
        model.state = state
        await model.loadSeries()
        await transport.release()
        await entering.value
        #expect(model.snapshots.values.first?.data.raw["marker"] == .string("3mo"))
        await transport.pause(path: "/api/research/presentation")
        state = model.state
        state.rebase = true
        model.state = state
        await transport.waitForPause()
        #expect(model.presentation == nil)
        state.rebase = false
        model.state = state
        await transport.release()
        await model.loadSeries()
        #expect(model.state.rebase == false)
        #expect(model.presentation?.raw["result"]?["tag"] == .string("original"))
    }
    @Test func chartProjectionReceivesFullRawDecimalPointsAndNeverRunsNativeIndicatorMath() async throws {
        let transport = ChartTestTransport()
        var state = chartTestState()
        state.indicators = [.init(id: "indicator", type: "sma", period: 1, seriesId: "price")]
        state.oscillator = "rsi"
        let store = ChartTestStore(data: try ResearchChartLayoutCodec.save(.init(draft: state)))
        let model = chartTestModel(transport, store: store)
        await model.load(route: chartTestRoute)
        let input = try #require(await transport.presentationInputs.last)
        #expect(
            input["series"]?.arrayValue?[0]["points"]?.arrayValue?[0]["close"]
                == .number(Decimal(string: "123.456789012345678901")!))
        #expect(input["indicators"]?.arrayValue?[0]["period"] == .number(1))
        #expect(input["oscillator"] == .string("rsi"))
        #expect(model.presentation?.rows.first?["price"] == .number(77))
        #expect(model.presentation?.oscillatorRows.first?["rsi"] == .number(42))
    }
}
private let chartTestRoute = NativeRoute(path: "/research/charts")
private func chartTestState() -> ResearchChartBuilderState {
    .init(series: [.init(id: "price", symbol: "SYNTH")], oscillatorSeriesId: "price")
}
private func chartLargeUnicodeState() -> ResearchChartBuilderState {
    let series = (1...5).map { index in
        ResearchChartBuilderSeries(
            id: String(repeating: "界", count: 127) + String(index), symbol: "FRED\(index)", provider: "fred",
            macro: .init(provider: "fred", seriesId: "SERIES\(index)", title: String(repeating: "界", count: 256)))
    }
    let indicators = (0..<20).map { index in
        ResearchChartBuilderIndicator(
            id: String(repeating: "界", count: 126) + String(format: "%02d", index), type: "sma", period: 1,
            seriesId: series[0].id)
    }
    return .init(series: series, indicators: indicators)
}
@MainActor private func chartTestModel(
    _ transport: ChartTestTransport, store: ChartTestStore, clock: ChartTestClock = ChartTestClock()
) -> ResearchChartBuilderModel {
    .init(
        service: APIClient(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0),
        store: store, cache: ResearchReadCache(now: { clock.date }), now: { clock.date }, debounceMilliseconds: 1)
}
private final class ChartTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_767_225_600)
    var date: Date {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        value = value.addingTimeInterval(seconds)
    }
}
@MainActor private final class ChartTestStore: ResearchChartLayoutStore {
    var data: Data?
    var reads = 0
    var writes: [Data] = []
    var readFails = false
    var writeSucceeds = true
    var commitFailedWrites = false
    var pauseRead = false
    var pauseWrite = false
    private var readGate: CheckedContinuation<Void, Never>?
    private var writeGate: CheckedContinuation<Void, Never>?
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var writeWaiter: CheckedContinuation<Void, Never>?
    init(data: Data? = nil) { self.data = data }
    func waitForRead() async { if readGate == nil { await withCheckedContinuation { readWaiter = $0 } } }
    func waitForWrite() async { if writeGate == nil { await withCheckedContinuation { writeWaiter = $0 } } }
    func releaseRead() {
        readGate?.resume()
        readGate = nil
    }
    func releaseWrite() {
        writeGate?.resume()
        writeGate = nil
    }
    func read() async throws -> Data? {
        reads += 1
        let snapshot = data
        if pauseRead {
            pauseRead = false
            readWaiter?.resume()
            readWaiter = nil
            await withCheckedContinuation { readGate = $0 }
        }
        if readFails { throw APIError.backendUnavailable }
        return snapshot
    }
    func write(_ data: Data) async -> Bool {
        writes.append(data)
        if pauseWrite {
            pauseWrite = false
            writeWaiter?.resume()
            writeWaiter = nil
            await withCheckedContinuation { writeGate = $0 }
        }
        if writeSucceeds || commitFailedWrites { self.data = data }
        return writeSucceeds
    }
}
private actor ChartTestTransport: APITransport {
    var requests: [APIRequest] = []
    var presentationInputs: [TaxValue] = []
    var chartReads: Int { requests.filter { $0.url.path == "/api/research/chart" }.count }
    private var pausedPath: String?
    private var began = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func pause(path: String) {
        pausedPath = path
        began = false
    }
    func waitForPause() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        if pausedPath == request.url.path {
            pausedPath = nil
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let data: TaxValue
        var provider = "synthetic-provider"
        switch request.url.path {
        case "/api/research/chart":
            data = .object([
                "symbol": .string(query.first { $0.name == "symbol" }?.value ?? "SYNTH"), "currency": .string("EUR"),
                "marker": .string(query.first { $0.name == "range" }?.value ?? ""),
                "points": .array([
                    .object([
                        "time": .number(1_767_225_600_000),
                        "close": .number(Decimal(string: "123.456789012345678901")!), "high": .null, "low": .null,
                        "volume": .null,
                    ])
                ]),
            ])
        case "/api/research/macro/series":
            provider = query.first { $0.name == "provider" }?.value ?? "fred"
            data = .object([
                "provider": .string(provider), "seriesId": .string("TEST.ID"), "title": .string("Synthetic"),
                "units": .string("Index"),
                "points": .array([.object(["time": .number(1_767_225_600_000), "close": .null])]),
            ])
        case "/api/research/presentation":
            let body = String(decoding: request.body ?? Data(), as: UTF8.self)
            let json = try #require(
                body.components(separatedBy: "\r\n\r\n").dropFirst().first?.components(separatedBy: "\r\n--").first)
            let input = try JSONDecoder().decode(TaxValue.self, from: Data(json.utf8))
            presentationInputs.append(input)
            var row: [String: TaxValue] = ["time": .number(1_767_225_600_000)]
            for series in input["series"]?.arrayValue ?? [] {
                if let id = series["id"]?.stringValue { row[id] = .number(77) }
            }
            data = .object([
                "kind": .string("chart"),
                "result": .object([
                    "rows": .array([.object(row)]),
                    "oscillatorRows": .array([.object(["time": .number(1_767_225_600_000), "rsi": .number(42)])]),
                    "tag": .string(input["rebase"] == .bool(true) ? "rebased" : "original"),
                ]),
            ])
        default: throw APIError.invalidRequest("Unexpected Chart Builder fixture path " + request.url.path)
        }
        return .init(
            status: 200,
            body: try APIBody.encode(
                TaxValue.object([
                    "ok": .bool(true), "data": data,
                    "meta": .object(["provider": .string(provider), "source": .string("cache")]),
                ])))
    }
}
