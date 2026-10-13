import Foundation
import Observation

public protocol TaxWidgetSettingsService: Sendable {
    func readTaxWidgets() async throws -> OpenAPI.Setting
    func saveTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

extension APIClient: TaxWidgetSettingsService {
    public func readTaxWidgets() async throws -> OpenAPI.Setting {
        try await send(OpenAPIOperations.GetSetting(key: TaxWidgetsModel.settingsKey))
    }
    public func saveTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(
            OpenAPIOperations.SaveSetting(
                key: TaxWidgetsModel.settingsKey,
                body: OpenAPIOperations.SaveSetting.Body(value: value, expected: expected)))
    }
}

/// One page's preferences in the shared widget_visibility setting. The server's complete
/// baseline is forwarded unchanged, and late reads cannot undo a saved user choice.
@MainActor
@Observable
public final class TaxWidgetsModel {
    nonisolated public static let settingsKey = "widget_visibility"
    nonisolated public static let pageKey = "budgetTax"
    nonisolated public static let definitions: [InsightWidget] = [
        InsightWidget("summaryCards", "tax.widget.summaryCards"),
        InsightWidget("trendStrip", "tax.widget.trendStrip"),
        InsightWidget("yearComparison", "tax.widget.yearComparison"),
        InsightWidget("incomeBreakdown", "tax.widget.incomeBreakdown"),
        InsightWidget("pitBreakdown", "tax.widget.pitBreakdown"),
        InsightWidget("householdBreakdown", "tax.widget.householdBreakdown"),
        InsightWidget("taxRules", "tax.widget.belgianRulesTitle"),
        InsightWidget("yearlyOverview", "tax.widget.yearlyOverview"),
    ]
    public private(set) var visibility = InsightWidgetVisibility(nil)
    public private(set) var isLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var error: String?
    @ObservationIgnored public var didSave: (@MainActor @Sendable () -> Void)?
    @ObservationIgnored private let service: any TaxWidgetSettingsService
    @ObservationIgnored private var baseline: JSONValue = .object(["exists": .bool(false)])
    @ObservationIgnored private var revision = UUID()

    public init(service: any TaxWidgetSettingsService) { self.service = service }

    public func isVisible(_ id: String) -> Bool {
        guard let widget = Self.definitions.first(where: { $0.id == id }) else { return false }
        return visibility.isVisible(widget, page: Self.pageKey)
    }

    public func load() async {
        guard !isSaving else { return }
        let token = UUID()
        revision = token
        isLoading = true
        defer { if token == revision { isLoading = false } }
        do {
            let record = try await service.readTaxWidgets()
            guard token == revision, !Task.isCancelled else { return }
            try validate(record)
            visibility = InsightWidgetVisibility(record.value)
            baseline = record.expected
            isLoaded = true
            error = nil
        } catch {
            guard token == revision, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    public func setVisible(_ id: String, _ visible: Bool) async {
        guard Self.definitions.contains(where: { $0.id == id }) else { return }
        await save { $0.set(id, visible: visible, page: Self.pageKey) }
    }
    public func setAll(_ visible: Bool) async {
        await save { value in
            for widget in Self.definitions { value.set(widget.id, visible: visible, page: Self.pageKey) }
        }
    }
    public func reset() async { await save { $0.reset(page: Self.pageKey) } }

    /// Called after the retained settings screen writes preferences. A pending native
    /// save owns its baseline until it completes; subsequent load reads its saved record.
    public func invalidate() {
        guard !isSaving else { return }
        revision = UUID()
        isLoading = false
        isLoaded = false
    }

    private func save(_ change: (inout InsightWidgetVisibility) -> Void) async {
        guard isLoaded, !isSaving else { return }
        revision = UUID()
        isLoading = false
        let previous = visibility
        change(&visibility)
        isSaving = true
        error = nil
        do {
            let record = try await service.saveTaxWidgets(value: visibility.json, expected: baseline)
            try validate(record)
            baseline = record.expected
            visibility = InsightWidgetVisibility(record.value)
            revision = UUID()
            isSaving = false
            didSave?()
        } catch {
            visibility = previous
            self.error = error.localizedDescription
            revision = UUID()
            isSaving = false
        }
    }

    private func validate(_ record: OpenAPI.Setting) throws {
        guard record.key == Self.settingsKey,
            record.value.objectValue != nil,
            let exists = record.expected["exists"]?.boolValue,
            exists ? record.expected["value"] == record.value : record.expected["value"] == nil
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/settings/widget_visibility",
                    issues: ["key/expected: does not contain the setting's complete concurrency baseline"]))
        }
    }
}
