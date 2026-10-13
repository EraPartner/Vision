import Foundation
import Observation

@MainActor
@Observable
public final class SavedChartsModel {
    public var printLocalState = NativeStatisticsPrintLocalState()
    public private(set) var charts: [OpenAPI.SavedChart] = []
    public private(set) var datasets: [Int: CustomChartDataset] = [:]
    public private(set) var errors: [Int: String] = [:]
    public private(set) var isLoading = true
    public private(set) var error: String?
    public private(set) var recipients: [OpenAPI.Recipient] = []
    public private(set) var tags: [OpenAPI.Tag] = []
    public var draft: CustomChartDraft?
    public private(set) var editingId: Int?
    public private(set) var preview: CustomChartDataset?
    public private(set) var previewError: String?
    public private(set) var isPreviewLoading = false
    public private(set) var isSaving = false
    public private(set) var saveError: String?
    public var pendingDelete: OpenAPI.SavedChart?

    @ObservationIgnored private let service: any SavedChartsService
    @ObservationIgnored private var snapshot: StatisticsSnapshot?
    @ObservationIgnored private var currency = "EUR"
    @ObservationIgnored private var otherLabel = ""
    @ObservationIgnored private var previewRevision = UUID()
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var strings: (any Localizing)?

    public init(service: any SavedChartsService) { self.service = service }
    public func appear(snapshot: StatisticsSnapshot, currency: String, strings: any Localizing) async {
        self.strings = strings
        if self.currency != currency || self.snapshot != snapshot {
            datasets = [:]
            errors = [:]
        }
        self.snapshot = snapshot
        self.currency = currency
        otherLabel = strings.t("customChart.other")
        guard !isSaving else { return }
        let token = UUID()
        revision = token
        isLoading = charts.isEmpty
        do {
            async let charts = service.savedCharts()
            async let recipients = service.customChartRecipients()
            async let tags = service.customChartTags()
            let loaded = try await charts
            let loadedRecipients = (try? await recipients) ?? []
            let loadedTags = (try? await tags) ?? []
            guard token == revision, !Task.isCancelled else { return }
            self.charts = loaded
            error = nil
            self.recipients = loadedRecipients
            self.tags = loadedTags
            for chart in loaded {
                guard token == revision, !Task.isCancelled else { return }
                do {
                    let data = try await dataset(draft: CustomChartDraft(chart: chart))
                    guard token == revision, !Task.isCancelled else { return }
                    datasets[chart.id] = data
                    errors.removeValue(forKey: chart.id)
                } catch {
                    guard token == revision, !Task.isCancelled else { return }
                    errors[chart.id] = error.localizedDescription
                }
            }
        } catch { if token == revision { self.error = error.localizedDescription } }
        if token == revision { isLoading = false }
    }
    public func begin(chart: OpenAPI.SavedChart? = nil) {
        guard !isSaving else { return }
        editingId = chart?.id
        draft = chart.map(CustomChartDraft.init) ?? CustomChartDraft()
        preview = nil
        previewError = nil
        saveError = nil
    }
    public func close() {
        guard !isSaving else { return }
        previewRevision = UUID()
        previewTask?.cancel()
        draft = nil
        editingId = nil
        preview = nil
    }
    public func refreshPreview() async {
        previewTask?.cancel()
        let token = UUID()
        previewRevision = token
        guard let draft else { return }
        isPreviewLoading = true
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .milliseconds(250))
                let data = try await self.dataset(draft: draft)
                guard self.previewRevision == token, !Task.isCancelled else { return }
                self.preview = data
                self.previewError = nil
                self.isPreviewLoading = false
            } catch {
                guard self.previewRevision == token, !Task.isCancelled else { return }
                self.previewError = error.localizedDescription
                self.isPreviewLoading = false
            }
        }
        previewTask = task
        await task.value
    }
    private func dataset(draft: CustomChartDraft) async throws -> CustomChartDataset {
        guard let snapshot else { throw APIError.backendUnavailable }
        let service = service
        let currency = currency
        async let recipients: CustomRecipientPivot? =
            draft.allRecipients || !draft.recipientIds.isEmpty
            ? try await service.customRecipientPivot(currency: currency, draft: draft) : nil
        async let tags: CustomTagPivot? =
            draft.allTags || !draft.tagIds.isEmpty
            ? try await service.customTagPivot(currency: currency, draft: draft) : nil
        return try await CustomChartDataset(
            configuration: draft, statistics: snapshot, recipients: recipients, tags: tags, otherLabel: otherLabel)
    }
    public func save() async {
        guard let draft, draft.canSave, !isSaving else { return }
        revision = UUID()
        isLoading = false
        isSaving = true
        saveError = nil
        do {
            let saved = try await service.saveChart(id: editingId, draft: draft)
            if let index = charts.firstIndex(where: { $0.id == saved.id }) {
                charts[index] = saved
            } else {
                charts.append(saved)
            }
            isSaving = false
            close()
            datasets.removeValue(forKey: saved.id)
            errors.removeValue(forKey: saved.id)
        } catch {
            saveError = error.localizedDescription
            isSaving = false
        }
        if let snapshot, let strings { await appear(snapshot: snapshot, currency: currency, strings: strings) }
    }
    public func confirmDelete() async {
        guard let chart = pendingDelete, !isSaving else { return }
        revision = UUID()
        isLoading = false
        isSaving = true
        error = nil
        var mutationError: String?
        do {
            try await service.deleteSavedChart(id: chart.id)
            charts.removeAll { $0.id == chart.id }
            datasets.removeValue(forKey: chart.id)
            errors.removeValue(forKey: chart.id)
            pendingDelete = nil
        } catch { mutationError = error.localizedDescription }
        isSaving = false
        if let snapshot, let strings { await appear(snapshot: snapshot, currency: currency, strings: strings) }
        if let mutationError { error = mutationError }
    }
}
