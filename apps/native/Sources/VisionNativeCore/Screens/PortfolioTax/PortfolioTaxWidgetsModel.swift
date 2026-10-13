import Foundation
import Observation

@MainActor @Observable
public final class PortfolioTaxWidgetsModel {
    nonisolated public static let settingsKey = "widget_visibility"
    nonisolated public static let pageKey = "portfolioTax"
    nonisolated public static let definitions: [InsightWidget] = [
        InsightWidget("summaryCards", "tax.widget.summaryCards"),
        InsightWidget("taxByAssetClass", "tax.widget.taxByAssetClass"),
        InsightWidget("taxTypes", "tax.widget.taxTypes"),
        InsightWidget("yearlyTaxFeeTrend", "tax.widget.yearlyTaxFeeTrend"),
        InsightWidget("investmentBreakdown", "tax.widget.investmentBreakdown"),
        InsightWidget("profileInputs", "tax.widget.profileInputs"),
        InsightWidget("belgianRules", "tax.widget.belgianRules"),
    ]
    public private(set) var visibility = InsightWidgetVisibility(nil)
    public private(set) var isLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var error: String?
    @ObservationIgnored private let service: any PortfolioTaxService
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var baseline: JSONValue = .object(["exists": .bool(false)])
    public init(service: any PortfolioTaxService) { self.service = service }
    public func isVisible(_ id: String) -> Bool {
        Self.definitions.first { $0.id == id }.map { visibility.isVisible($0, page: Self.pageKey) } ?? false
    }
    public func invalidate() {
        guard !isSaving else { return }
        revision = UUID()
        isLoading = false
        isLoaded = false
    }
    public func load() async {
        guard !isSaving else { return }
        let token = UUID()
        revision = token
        isLoading = true
        defer { if token == revision { isLoading = false } }
        do {
            let record = try await service.portfolioTaxWidgetSetting()
            guard token == revision, !Task.isCancelled else { return }
            try validate(record)
            visibility = InsightWidgetVisibility(record.value)
            baseline = record.expected
            isLoaded = true
            error = nil
        } catch {
            if token == revision, !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    public func setVisible(_ id: String, _ visible: Bool) async {
        guard Self.definitions.contains(where: { $0.id == id }) else { return }
        await save { $0.set(id, visible: visible, page: Self.pageKey) }
    }
    public func setAll(_ visible: Bool) async {
        await save { values in
            for widget in Self.definitions { values.set(widget.id, visible: visible, page: Self.pageKey) }
        }
    }
    public func reset() async {
        await save { visibility in
            var page = visibility.pages[Self.pageKey]?.objectValue ?? [:]
            for widget in Self.definitions { page.removeValue(forKey: widget.id) }
            visibility.pages[Self.pageKey] = page.isEmpty ? nil : .object(page)
        }
    }
    private func save(_ change: (inout InsightWidgetVisibility) -> Void) async {
        guard isLoaded, !isSaving else { return }
        revision = UUID()
        isLoading = false
        let previous = visibility
        change(&visibility)
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let record = try await service.savePortfolioTaxWidgets(value: visibility.json, expected: baseline)
            try validate(record)
            baseline = record.expected
            visibility = InsightWidgetVisibility(record.value)
        } catch {
            visibility = previous
            self.error = error.localizedDescription
        }
    }
    private func validate(_ record: OpenAPI.Setting) throws {
        guard record.key == Self.settingsKey, record.value.objectValue != nil || record.value == .null,
            let fields = record.expected.objectValue, let exists = fields["exists"]?.boolValue,
            Set(fields.keys) == (exists ? ["exists", "value"] : ["exists"])
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/settings/widget_visibility",
                    issues: ["Invalid setting value or complete concurrency baseline"]))
        }
    }
}
