import Foundation
import Observation

@MainActor @Observable public final class AIChatModel {
    public private(set) var selectedID: String?
    public private(set) var mode: AIChatMode = .chat
    public var draft = ""
    public var modelOverride: String?
    public var useTools = true
    public var isOnline = true
    public private(set) var conversations: [AIChatConversation] = []
    public private(set) var hasMore = false
    public private(set) var status: AIChatOllamaStatus?
    public private(set) var models: [AIChatOllamaModel] = []
    public private(set) var isLoadingConversations = false
    public private(set) var isLoadingMore = false
    public private(set) var isLoadingDetail = false
    public private(set) var isLoadingStatus = false
    public private(set) var isLoadingModels = false
    public private(set) var isCreating = false
    public private(set) var isRenaming = false
    public private(set) var isDeleting = false
    public private(set) var errors: [String: String] = [:]
    public private(set) var notice: ScreenNotice?
    public let streams: AIChatStreamStore
    public var didReplaceRoute: (@MainActor (NativeRoute) -> Void)?
    public var detail: AIChatConversationDetail? {
        selectedID.flatMap { streams.details[$0] } ?? (selectedID == nil ? nil : placeholderDetail)
    }
    public var streamSnapshot: AIChatStreamSnapshot { streams.snapshot(id: selectedID) }
    public var streamingIDs: [String] { streams.activeIDs }
    public var activeModel: String? {
        modelOverride ?? detail?.conversation.model ?? settings.aiDefaultModel ?? status?.defaultModel
    }
    public var composerDisabled: Bool { status?.ok != true }
    public var canSend: Bool {
        !composerDisabled && !streamSnapshot.isStreaming && !isCreating
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 4000
    }
    public var statusPollInterval: TimeInterval? {
        if status?.enabled == false { return nil }
        return errors["status"] != nil || status?.ok == false ? 120 : 30
    }
    public var messages: [AIChatMessage] {
        let persisted = detail?.messages ?? []
        var seen = Set(persisted.map(\.id))
        var result = persisted
        let snapshot = streamSnapshot
        if let user = snapshot.userMessage, !seen.contains(user.id),
            !(user.isOptimistic && persisted.contains { $0.role == "user" && $0.content == user.content })
        {
            result.append(user)
            seen.insert(user.id)
        }
        for tool in snapshot.toolMessages where seen.insert(tool.id).inserted { result.append(tool) }
        return result
    }
    @ObservationIgnored private let service: any AIChatService
    @ObservationIgnored private let now: @Sendable () -> Date
    private var settings = NativeAppSettings.defaults
    private var placeholderDetail: AIChatConversationDetail?
    @ObservationIgnored private var route = NativeRoute(path: "/ai-chat")
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var selectionRevision = UUID()
    @ObservationIgnored private var listRevision = UUID()
    @ObservationIgnored private var statusRevision = UUID()
    @ObservationIgnored private var modelRevision = UUID()
    @ObservationIgnored private var listDate: Date?
    @ObservationIgnored private var statusDate: Date?
    @ObservationIgnored private var modelsDate: Date?
    @ObservationIgnored private var pages: [AIChatConversationPage] = []
    @ObservationIgnored private var detailRefreshNeeded = false
    @ObservationIgnored private var listRefreshNeeded = false
    @ObservationIgnored private var noticeID = 0
    public init(
        service: any AIChatService, streams: AIChatStreamStore? = nil, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.now = now
        self.streams = streams ?? AIChatStreamStore(service: service, now: now)
        self.streams.didInvalidate = { [weak self] id in
            guard let self else { return }
            self.listDate = nil
            self.streams.invalidateDetail(id: id)
            guard self.isActive else { return }
            async let rail: Void = self.loadConversations(force: true)
            if self.selectedID == id { await self.loadDetail(force: true) }
            await rail
        }
        self.streams.didError = { [weak self] error in self?.showNotice("aiChat.sendFailed", error: error) }
    }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func configure(settings: NativeAppSettings) { self.settings = settings }
    public func load(route: NativeRoute, force: Bool = false) async {
        let beginningVisit = !isActive
        if !isActive {
            isActive = true
            visit = UUID()
        }
        self.route = route
        mode = route.value("mode") == "investigation" ? .investigation : .chat
        let id = route.value("c") ?? streams.activeIDs.first
        let selectionChanged = selectedID != id
        if selectionChanged {
            placeholderDetail = detail
            selectedID = id
            selectionRevision = UUID()
            isLoadingDetail = false
        }
        if route.value("c") == nil, let id {
            self.route = route.setting("c", to: id)
            didReplaceRoute?(self.route)
        }
        if beginningVisit || force {
            await refreshPageReads(force: force)
        } else if selectionChanged {
            await loadDetail()
        }
    }
    public func refreshPageReads(force: Bool = false) async {
        guard isActive else { return }
        async let rail: Void = loadConversations(force: force)
        async let health: Void = loadStatus(force: force)
        async let transcript: Void = loadDetail(force: force)
        _ = await (rail, health, transcript)
        await loadModels()
    }
    public func setMode(_ mode: AIChatMode) {
        self.mode = mode
        route = route.setting("mode", to: mode.rawValue)
        didReplaceRoute?(route)
    }
    public func select(id: String?) async {
        guard selectedID != id else { return }
        placeholderDetail = detail
        selectedID = id
        selectionRevision = UUID()
        isLoadingDetail = false
        route = id.map { route.setting("c", to: $0) } ?? route.removing("c")
        didReplaceRoute?(route)
        await loadDetail()
    }
    public func loadStatus(force: Bool = false) async {
        guard isActive, isOnline, !isLoadingStatus,
            force || statusDate.map({ now().timeIntervalSince($0) >= 15 }) != false
        else {
            return
        }
        let revision = UUID()
        statusRevision = revision
        isLoadingStatus = true
        defer { if revision == statusRevision { isLoadingStatus = false } }
        do {
            let result = try await service.chatStatus()
            guard revision == statusRevision, isActive else { return }
            status = result
            statusDate = now()
            errors["status"] = nil
            if result.ok { await loadModels() }
        } catch { if revision == statusRevision, isActive { errors["status"] = error.localizedDescription } }
    }
    private func loadModels(force: Bool = false) async {
        guard isActive, isOnline, status?.ok == true, !isLoadingModels,
            force || modelsDate.map({ now().timeIntervalSince($0) >= 60 }) != false
        else { return }
        let revision = UUID()
        modelRevision = revision
        isLoadingModels = true
        defer { if revision == modelRevision { isLoadingModels = false } }
        do {
            let result = try await service.chatModels()
            guard revision == modelRevision, isActive else { return }
            models = result
            modelsDate = now()
            errors["models"] = nil
        } catch { if revision == modelRevision, isActive { errors["models"] = error.localizedDescription } }
    }
    public func retryStatus() async {
        statusDate = nil
        modelsDate = nil
        await loadStatus(force: true)
    }
    public func pollStatus() async { await loadStatus(force: true) }
    private func checkPage(_ page: AIChatConversationPage, offset: Int) throws {
        guard page.offset == offset, page.limit == 50, page.total >= 0, page.items.count <= 50 else {
            throw APIError.invalidRequest("Unexpected conversation page")
        }
    }
    public func loadConversations(force: Bool = false) async {
        if force, isLoadingConversations || isLoadingMore { listRefreshNeeded = true }
        guard isActive, isOnline, !isLoadingConversations, !isLoadingMore,
            force || listDate.map({ now().timeIntervalSince($0) >= 30 }) != false
        else { return }
        let revision = UUID()
        listRevision = revision
        isLoadingConversations = true
        defer {
            if revision == listRevision {
                isLoadingConversations = false
                if listRefreshNeeded, isActive {
                    listRefreshNeeded = false
                    Task { await loadConversations(force: true) }
                }
            }
        }
        do {
            var refreshed: [AIChatConversationPage] = []
            var offset = 0
            for _ in 0..<max(1, pages.count) {
                let page = try await service.chatConversations(offset: offset)
                try checkPage(page, offset: offset)
                guard revision == listRevision, isActive else { return }
                refreshed.append(page)
                offset = page.offset + page.items.count
                if page.items.isEmpty || offset >= page.total { break }
            }
            pages = refreshed
            publishPages()
            listDate = now()
            errors["conversations"] = nil
        } catch { if revision == listRevision, isActive { errors["conversations"] = error.localizedDescription } }
    }
    private func publishPages() {
        conversations = pages.flatMap(\.items)
        hasMore = pages.last.map { !$0.items.isEmpty && $0.offset + $0.items.count < $0.total } ?? false
    }
    public func loadMore() async {
        guard isActive, isOnline, hasMore, !isLoadingMore, !isLoadingConversations, let last = pages.last else {
            return
        }
        let revision = listRevision
        let offset = last.offset + last.items.count
        isLoadingMore = true
        defer {
            if revision == listRevision {
                isLoadingMore = false
                if listRefreshNeeded, isActive {
                    listRefreshNeeded = false
                    Task { await loadConversations(force: true) }
                }
            }
        }
        do {
            let page = try await service.chatConversations(offset: offset)
            try checkPage(page, offset: offset)
            guard revision == listRevision, isActive else { return }
            pages.append(page)
            publishPages()
            errors["conversations"] = nil
        } catch { if revision == listRevision, isActive { errors["conversations"] = error.localizedDescription } }
    }
    public func loadDetail(force: Bool = false) async {
        if force, isLoadingDetail { detailRefreshNeeded = true }
        guard isActive, isOnline, let id = selectedID, !isLoadingDetail else { return }
        if !force, let date = streams.detailDates[id], now().timeIntervalSince(date) < 10 {
            sweep(id: id)
            return
        }
        let revision = selectionRevision
        let sourceRevision = streams.revision(id: id)
        isLoadingDetail = true
        defer {
            if revision == selectionRevision {
                isLoadingDetail = false
                if detailRefreshNeeded, isActive {
                    detailRefreshNeeded = false
                    Task { await loadDetail(force: true) }
                }
            }
        }
        do {
            let result = try await service.chatConversation(id: id)
            guard result.conversation.id == id else { throw APIError.invalidRequest("Wrong conversation identity") }
            guard revision == selectionRevision, selectedID == id, isActive else { return }
            guard sourceRevision == streams.revision(id: id) else {
                detailRefreshNeeded = true
                return
            }
            streams.cache(result)
            placeholderDetail = nil
            errors["detail"] = nil
            sweep(id: id)
        } catch { if revision == selectionRevision, isActive { errors["detail"] = error.localizedDescription } }
    }
    private func sweep(id: String) {
        let snapshot = streams.snapshot(id: id)
        guard snapshot.isStreaming, let user = snapshot.userMessage, !user.isOptimistic,
            let messages = streams.details[id]?.messages,
            let userIndex = messages.firstIndex(where: { $0.id == user.id }),
            let last = messages.indices.last, last > userIndex, messages[last].role == "assistant"
        else { return }
        streams.clear(id: id)
    }
    @discardableResult public func create() async -> String? { await create(model: nil) }
    private func create(model: String?) async -> String? {
        guard !isCreating else { return nil }
        isCreating = true
        let capturedVisit = visit
        let selection = selectionRevision
        defer { isCreating = false }
        do {
            let result = try await service.chatCreate(model: model)
            streams.cache(result)
            listDate = nil
            if isActive, capturedVisit == visit, selection == selectionRevision {
                await select(id: result.conversation.id)
            }
            if isActive { Task { await loadConversations(force: true) } }
            return result.conversation.id
        } catch {
            listDate = nil
            showNotice("aiChat.createFailed", error: error)
            if isActive { await loadConversations(force: true) }
            return nil
        }
    }
    @discardableResult public func rename(id: String, title: String) async -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isRenaming, !title.isEmpty, title.utf16.count <= 120 else { return false }
        isRenaming = true
        defer { isRenaming = false }
        do {
            let result = try await service.chatRename(id: id, title: title)
            guard result.id == id else { throw APIError.invalidRequest("Wrong renamed conversation identity") }
            if let previous = streams.details[id] {
                streams.cache(.init(conversation: result, messages: previous.messages))
            }
            listDate = nil
            if isActive { await loadConversations(force: true) }
            return true
        } catch {
            listDate = nil
            showNotice("aiChat.renameFailed", error: error)
            if isActive {
                await loadConversations(force: true)
                if selectedID == id { await loadDetail(force: true) }
            }
            return false
        }
    }
    @discardableResult public func delete(id: String) async -> Bool {
        guard !isDeleting else { return false }
        isDeleting = true
        defer { isDeleting = false }
        streams.stop(id: id)
        streams.remove(id: id)
        if selectedID == id { await select(id: nil) }
        do {
            try await service.chatDelete(id: id)
            listDate = nil
            showNotice("aiChat.deleted")
            if isActive { await loadConversations(force: true) }
            return true
        } catch {
            listDate = nil
            showNotice("aiChat.deleteFailed", error: error)
            if isActive { await loadConversations(force: true) }
            return false
        }
    }
    public func send() async {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        await send(message: text, digest: false)
    }
    public func digest(prompt: String) async {
        guard !composerDisabled, !streamSnapshot.isStreaming else { return }
        await send(message: prompt, digest: true)
    }
    private func send(message: String, digest: Bool) async {
        let model = activeModel
        let tools = digest ? true : useTools
        let id: String
        if let selectedID {
            id = selectedID
        } else {
            guard let created = await create(model: model?.isEmpty == true ? nil : model) else { return }
            id = created
        }
        await streams.send(
            .init(conversationID: id, message: message, model: model, useTools: tools, insightsPreCall: digest))
    }
    public func retryLastTurn() async {
        guard !composerDisabled, !streamSnapshot.isStreaming, var request = streamSnapshot.lastRequest else { return }
        request.retryLastTurn = true
        await streams.send(request)
    }
    public func stop() { if let selectedID { streams.stop(id: selectedID) } }
    public func invalidate() {
        listDate = nil
        statusDate = nil
        modelsDate = nil
    }
    public func didDisappear() {
        isActive = false
        visit = UUID()
        selectionRevision = UUID()
        listRevision = UUID()
        statusRevision = UUID()
        modelRevision = UUID()
        isLoadingConversations = false
        isLoadingMore = false
        isLoadingDetail = false
        isLoadingStatus = false
        isLoadingModels = false
        detailRefreshNeeded = false
        listRefreshNeeded = false
        draft = ""
        modelOverride = nil
        useTools = true
        selectedID = nil
        placeholderDetail = nil
        mode = .chat
    }
    private func showNotice(_ key: String, error: Error? = nil) {
        noticeID += 1
        notice = .init(
            id: noticeID, kind: error == nil ? .success : .error, key: key, detail: error?.localizedDescription)
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
}
