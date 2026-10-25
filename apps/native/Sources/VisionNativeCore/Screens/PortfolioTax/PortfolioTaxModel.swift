import Foundation
import Observation

@MainActor @Observable
public final class PortfolioTaxModel {
    public let widgets: PortfolioTaxWidgetsModel
    public private(set) var dashboard: PortfolioTaxDashboard?
    public private(set) var error: String?
    public private(set) var isFetching = false
    public var isLoading: Bool { isFetching && dashboard == nil }
    public private(set) var isAdjustmentsPresented = false
    public private(set) var isSavingAdjustments = false
    public var isLoadingAdjustments: Bool { !settingsLoaded && isFetching }
    public private(set) var adjustmentsError: String?
    public private(set) var settingsLoaded = false
    public private(set) var adjustmentYear: Int?
    public private(set) var draftRows: [PortfolioTaxAdjustmentDraft] = []
    public private(set) var focusInvestmentID: Int?
    public private(set) var notice: ScreenNotice?
    /// Invalidates related screens after any write attempt, including a lost acknowledgement.
    /// Completion does not indicate that the mutation was acknowledged successfully.
    @ObservationIgnored public var didSave: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any PortfolioTaxService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var context: Context?
    @ObservationIgnored private var liveYear: Int?
    @ObservationIgnored private var settingsDraft: PortfolioTaxSettingsDraft?
    @ObservationIgnored private var editorDraft: PortfolioTaxSettingsDraft?
    @ObservationIgnored private var numberFormat: NumberFormat = .eu
    @ObservationIgnored private var notices = NoticeCounter()
    private struct Context: Equatable {
        let year: Int
        let currency: String
    }

    public init(service: any PortfolioTaxService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
        widgets = PortfolioTaxWidgetsModel(service: service)
    }
    public var draftTotals: (taxes: Decimal, fees: Decimal) {
        draftRows.reduce((Decimal.zero, Decimal.zero)) { result, row in
            (
                result.0 + LocaleNumber.parseOrZero(row.taxes, format: numberFormat),
                result.1 + LocaleNumber.parseOrZero(row.fees, format: numberFormat)
            )
        }
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }
    public func invalidate() {
        revision = UUID()
        task?.cancel()
        task = nil
        fetchedAt = nil
        isFetching = false
        widgets.invalidate()
        if !isAdjustmentsPresented && !isSavingAdjustments {
            settingsLoaded = false
            settingsDraft = nil
        }
    }
    public func load(year: Int, liveYear: Int, currency: String, force: Bool = false) async {
        self.liveYear = liveYear
        let next = Context(year: year, currency: currency)
        if context != next {
            invalidate()
            context = next
            dashboard = nil
            error = nil
        }
        async let widgetLoad: Void = widgets.isLoaded && !force ? () : widgets.load()
        await loadDashboard(next, force: force)
        await widgetLoad
    }
    private func loadDashboard(_ requested: Context, force: Bool) async {
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 30 { return }
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        isFetching = true
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await service.portfolioTaxDashboard(year: requested.year, currency: requested.currency)
                guard token == revision, !Task.isCancelled else { return }
                try value.validate(year: requested.year, currency: requested.currency)
                dashboard = value
                error = nil
                fetchedAt = now()
                if !isAdjustmentsPresented && editorDraft == nil {
                    do {
                        settingsDraft = try PortfolioTaxSettingsDraft(records: value.records)
                        settingsLoaded = true
                        adjustmentsError = nil
                    } catch {
                        settingsDraft = nil
                        settingsLoaded = false
                        adjustmentsError = error.localizedDescription
                    }
                }
            } catch {
                guard token == revision, !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
        self.task = task
        await task.value
        guard token == revision else { return }
        self.task = nil
        isFetching = false
    }

    @discardableResult public func beginAdjustments(numberFormat: NumberFormat) -> Bool {
        guard !isAdjustmentsPresented, !isSavingAdjustments, settingsLoaded,
            let settingsDraft, let dashboard, let liveYear
        else { return false }
        self.numberFormat = numberFormat
        adjustmentYear = liveYear
        editorDraft = settingsDraft
        draftRows = dashboard.summaries.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            .map {
                PortfolioTaxAdjustmentDraft(investment: $0, year: liveYear, values: settingsDraft, format: numberFormat)
            }
        focusInvestmentID = nil
        adjustmentsError = nil
        isAdjustmentsPresented = true
        return true
    }
    public func updateDraft(id: Int, _ update: (inout PortfolioTaxAdjustmentDraft) -> Void) {
        guard isAdjustmentsPresented, !isSavingAdjustments,
            let index = draftRows.firstIndex(where: { $0.id == id })
        else { return }
        update(&draftRows[index])
        focusInvestmentID = nil
        adjustmentsError = nil
    }
    @discardableResult public func closeAdjustments() -> Bool {
        guard !isSavingAdjustments else { return false }
        isAdjustmentsPresented = false
        editorDraft = nil
        draftRows = []
        adjustmentYear = nil
        focusInvestmentID = nil
        if let dashboard, error == nil, !isFetching,
            let latest = try? PortfolioTaxSettingsDraft(records: dashboard.records)
        {
            settingsDraft = latest
            settingsLoaded = true
        } else {
            settingsDraft = nil
            settingsLoaded = false
            fetchedAt = nil
        }
        adjustmentsError = nil
        return true
    }
    @discardableResult public func saveAdjustments() async -> Bool {
        guard isAdjustmentsPresented, !isSavingAdjustments, let year = adjustmentYear,
            var values = editorDraft
        else { return false }
        if let index = draftRows.firstIndex(where: \.hasInvalidInterestPortion) {
            draftRows[index].treatmentExpanded = true
            focusInvestmentID = draftRows[index].id
            return false
        }
        isSavingAdjustments = true
        adjustmentsError = nil
        var attemptedWrite = false
        defer { isSavingAdjustments = false }
        do {
            try values.apply(rows: draftRows, year: year, format: numberFormat)
            attemptedWrite = true
            try await service.savePortfolioTaxSettings(values.patch)
            // A settings acknowledgement does not return new CAS tokens. Only a new dashboard
            // read can seed the next editor; never reuse the submitted baseline after saving.
            isAdjustmentsPresented = false
            editorDraft = nil
            settingsDraft = nil
            settingsLoaded = false
            draftRows = []
            adjustmentYear = nil
            focusInvestmentID = nil
            notice = notices.make(.success, "tax.manualAdjustmentsSaved")
            await didSave?()
            if let context, let liveYear {
                invalidate()
                // Adopt a new baseline during this refresh, while guarding all form edits.
                await load(year: context.year, liveYear: liveYear, currency: context.currency, force: true)
            }
            return true
        } catch {
            adjustmentsError = error.localizedDescription
            notice = notices.make(.error, "tax.manualAdjustmentsSaveFailed", detail: error.localizedDescription)
            if attemptedWrite {
                // A response can be lost after PostgreSQL commits. Refresh the displayed
                // authority, retaining the form and its original CAS for review/cancel.
                await didSave?()
                if let context, let liveYear {
                    invalidate()
                    await load(year: context.year, liveYear: liveYear, currency: context.currency, force: true)
                }
            }
            return false
        }
    }
}
