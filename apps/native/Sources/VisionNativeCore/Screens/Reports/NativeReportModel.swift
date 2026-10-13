import Foundation
import Observation

@MainActor @Observable public final class NativeReportModel {
    public private(set) var type: NativeReportType = .financial
    public private(set) var origin: String?
    public var periodPreset: NativeReportPeriodPreset = .rolling12
    public var customYear = ""
    public var customFrom = ""
    public var customTo = ""
    public var currency = "EUR"
    public private(set) var selectedSections: Set<String> = []
    private var sectionOrder: [String] = []
    public private(set) var isSubmitting = false
    public private(set) var isPresented = false
    public private(set) var isRetired = false
    public private(set) var errorDetail: String?
    @ObservationIgnored private let service: any NativeReportService
    @ObservationIgnored private let callbacks: NativeReportCallbacks
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var configuredOriginPath: String?
    @ObservationIgnored private var noticeID = 0
    public init(
        service: any NativeReportService, callbacks: NativeReportCallbacks,
        now: @escaping @MainActor () -> Date = Date.init, calendar: Calendar = .current
    ) {
        self.service = service
        self.callbacks = callbacks
        self.now = now
        self.calendar = calendar
    }
    public var currentYear: Int { calendar.component(.year, from: now()) }
    public var maxYear: Int { currentYear + 1 }
    public var today: String { NativeReportForm.day(now(), calendar: calendar) }
    public var sections: [NativeReportSection] { type.sections }
    public var allSectionsSelected: Bool { sections.allSatisfy { selectedSections.contains($0.id) } }
    public var someSectionsSelected: Bool { !selectedSections.isEmpty && !allSectionsSelected }
    public var customRangeInvalid: Bool {
        periodPreset == .custom && !NativeReportForm.isValidCustomRange(from: customFrom, to: customTo)
    }
    public var customYearInvalid: Bool {
        periodPreset == .year && !NativeReportForm.isValidYear(customYear, currentYear: currentYear)
    }
    public var canSubmit: Bool {
        !isRetired && isPresented && !isSubmitting && !selectedSections.isEmpty && !customRangeInvalid
            && !customYearInvalid
    }
    public var exclusions: NativeReportPreferences? {
        let preferences = callbacks.preferences()
        return preferences.exclusionsApply(type: type) ? preferences : nil
    }
    public func configure(type: NativeReportType, origin: String? = nil) {
        guard !isRetired else { return }
        generation = UUID()
        let path = origin?.split(separator: "?", maxSplits: 1).first.map(String.init)
        let samePage = path != nil && configuredOriginPath == path
        self.origin = origin
        configuredOriginPath = path
        isSubmitting = false
        isPresented = true
        errorDetail = nil
        guard !samePage else { return }
        self.type = type
        periodPreset = .rolling12
        customYear = String(currentYear)
        customFrom = "\(currentYear - 1)-01-01"
        customTo = today
        let preferred = callbacks.preferences().currency
        currency = preferred.isEmpty ? "EUR" : preferred
        sectionOrder = type.sections.map(\.id)
        selectedSections = Set(sectionOrder)
        isSubmitting = false
        isPresented = true
        errorDetail = nil
    }
    public func setType(_ type: NativeReportType) {
        self.type = type
        sectionOrder = type.sections.map(\.id)
        selectedSections = Set(sectionOrder)
    }
    public func setSection(_ id: String, selected: Bool) {
        guard sections.contains(where: { $0.id == id }) else { return }
        if selected {
            if selectedSections.insert(id).inserted { sectionOrder.append(id) }
        } else {
            selectedSections.remove(id)
            sectionOrder.removeAll { $0 == id }
        }
    }
    public func setAllSections(_ selected: Bool) {
        sectionOrder = selected ? sections.map(\.id) : []
        selectedSections = Set(sectionOrder)
    }
    public func close() {
        guard !isRetired else { return }
        didDisappear()
        callbacks.close()
    }
    public func didDisappear() {
        generation = UUID()
        isPresented = false
        isSubmitting = false
    }
    /// Closing a dialog keeps its page-owned form; leaving the page retires that draft.
    public func didLeavePage() {
        didDisappear()
        configuredOriginPath = nil
    }
    public func retireForReload() {
        isRetired = true
        didDisappear()
    }
    public func submit(output: NativeReportOutput = .download) async {
        guard canSubmit else { return }
        if case .print = output, callbacks.print == nil { return }
        let visit = generation
        let reportType = type
        let period: NativeReportPeriod
        switch periodPreset {
        case .ytd: period = .ytd
        case .rolling3: period = .rolling(months: 3)
        case .rolling12: period = .rolling(months: 12)
        case .year: period = .year(Int(customYear) ?? currentYear)
        case .custom: period = .custom(from: customFrom, to: customTo)
        }
        let selected = allSectionsSelected ? [] : sectionOrder
        let preferences = callbacks.preferences()
        let filtered = preferences.exclusionsApply(type: reportType)
        var body: [String: TaxValue] = [
            "currency": .string(currency), "period": period.value,
            "sections": .array(selected.map(TaxValue.string)),
            "excludedCategoryIds": .array(
                (filtered ? preferences.excludedCategoryIds : []).map { .number(Decimal($0)) }),
            "excludedRecipientIds": .array(
                (filtered ? preferences.excludedRecipientIds : []).map { .number(Decimal($0)) }),
        ]
        isSubmitting = true
        errorDetail = nil
        defer { if generation == visit { isSubmitting = false } }
        do {
            if reportType == .tax {
                guard let year = period.taxYear(today: today) else { throw APIError.invalidRequest("Report tax year") }
                let context = try await callbacks.taxContext(year)
                guard generation == visit else { return }
                guard let fields = context.objectValue else { throw APIError.invalidRequest("Report tax context") }
                for key in ["taxProfile", "precomputedPIT", "household", "precomputedHousehold"] {
                    if let value = fields[key], value != .null { body[key] = value }
                }
            }
            body["theme"] = try await callbacks.theme()
            guard generation == visit else { return }
            let response = try await service.generate(NativeReportRequest(type: reportType, body: .object(body)))
            guard generation == visit else { return }
            // Match the existing helper: name uses the app-local day after the PDF arrives.
            let name = "vision-\(reportType.rawValue)-\(today).pdf"
            let completed: Bool
            switch output {
            case .download: completed = try await callbacks.save(response.body, name)
            case .print: completed = try await callbacks.print?(response.body, name) ?? false
            }
            guard generation == visit, completed else { return }
            if case .download = output { publish("statsPage.report.downloadSuccess") }
            close()
        } catch is CancellationError {
        } catch {
            guard generation == visit else { return }
            errorDetail = error.localizedDescription
            publish("statsPage.report.downloadError", kind: .error, detail: error.localizedDescription)
        }
    }
    private func publish(_ key: String, kind: ScreenNotice.Kind = .success, detail: String? = nil) {
        noticeID += 1
        callbacks.notice(ScreenNotice(id: noticeID, kind: kind, key: key, detail: detail))
    }
}
