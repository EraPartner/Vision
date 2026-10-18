import Foundation
import Observation

public protocol PortfolioWidgetService: Sendable {
    func portfolioWidgetSetting() async throws -> OpenAPI.Setting
    func savePortfolioWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

@MainActor @Observable
public final class PortfolioWidgetsModel {
    public static let definitions = [
        InsightWidget("ticker", "portfolio.widget.ticker"),
        InsightWidget("investments", "portfolio.widget.holdings"),
        InsightWidget("allocation", "portfolio.widget.allocation"),
        InsightWidget("performance", "portfolio.gainsIncomeAndCosts"),
        InsightWidget("exposure", "portfolio.exposure.title"),
        InsightWidget("valueChart", "performance.valueOverTime"),
        InsightWidget("brokerChart", "performance.byBrokerTitle"),
        InsightWidget("relativeChart", "performance.relativeTitle"),
        InsightWidget("breakdown", "portfolio.widget.breakdown"),
        InsightWidget("news", "portfolio.widget.news"),
        InsightWidget("archived", "portfolio.archivedInvestments"),
    ]
    public private(set) var visibility = InsightWidgetVisibility(nil)
    public private(set) var isLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var error: String?
    @ObservationIgnored public var didSave: (@MainActor () -> Void)?
    @ObservationIgnored private let service: any PortfolioWidgetService
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var baseline: JSONValue = .object(["exists": .bool(false)])
    public init(service: any PortfolioWidgetService) { self.service = service }
    public func isVisible(_ id: String) -> Bool {
        Self.definitions.first { $0.id == id }.map { visibility.isVisible($0, page: "portfolio") } ?? false
    }
    public func invalidate() {
        guard !isSaving else { return }
        revision = UUID()
        isLoaded = false
        isLoading = false
    }
    public func load() async {
        guard !isSaving else { return }
        let token = UUID()
        revision = token
        isLoading = true
        defer { if token == revision { isLoading = false } }
        do {
            let setting = try await service.portfolioWidgetSetting()
            guard token == revision, !Task.isCancelled else { return }
            try validate(setting)
            visibility = InsightWidgetVisibility(setting.value)
            baseline = setting.expected
            isLoaded = true
            error = nil
        } catch { if token == revision, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    public func setVisible(_ id: String, _ visible: Bool) async {
        guard Self.definitions.contains(where: { $0.id == id }) else { return }
        await save { $0.set(id, visible: visible, page: "portfolio") }
    }
    public func setAll(_ visible: Bool) async {
        await save { values in
            for widget in Self.definitions { values.set(widget.id, visible: visible, page: "portfolio") }
        }
    }
    public func reset() async { await save { $0.reset(page: "portfolio") } }
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
            let record = try await service.savePortfolioWidgets(value: visibility.json, expected: baseline)
            try validate(record)
            baseline = record.expected
            visibility = InsightWidgetVisibility(record.value)
        } catch {
            visibility = previous
            self.error = error.localizedDescription
            // A lost acknowledgement can follow a committed write. Read the current
            // whole value before another edit so its CAS token cannot remain stale.
            if let record = try? await service.portfolioWidgetSetting(), (try? validate(record)) != nil {
                baseline = record.expected
                visibility = InsightWidgetVisibility(record.value)
            }
        }
        revision = UUID()
        if error == nil { didSave?() }
    }
    private func validate(_ record: OpenAPI.Setting) throws {
        guard record.key == "widget_visibility", InsightWidgetVisibility.isValidSetting(record.value),
            let exists = record.expected["exists"]?.boolValue,
            Set(record.expected.objectValue?.keys ?? [String: JSONValue]().keys)
                == (exists ? ["exists", "value"] : ["exists"])
        else {
            throw APIError.contract(
                APIContractError(endpoint: "/api/settings/widget_visibility", issues: ["Invalid setting baseline"]))
        }
    }
}
