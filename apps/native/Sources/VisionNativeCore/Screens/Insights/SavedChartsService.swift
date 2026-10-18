import Foundation

public protocol SavedChartsService: Sendable {
    func savedCharts() async throws -> [OpenAPI.SavedChart]
    func saveChart(id: Int?, draft: CustomChartDraft) async throws -> OpenAPI.SavedChart
    func deleteSavedChart(id: Int) async throws
    func customRecipientPivot(currency: String, draft: CustomChartDraft) async throws -> CustomRecipientPivot
    func customTagPivot(currency: String, draft: CustomChartDraft) async throws -> CustomTagPivot
    func customChartRecipients() async throws -> [OpenAPI.Recipient]
    func customChartTags() async throws -> [OpenAPI.Tag]
}

extension APIClient: SavedChartsService {
    public func savedCharts() async throws -> [OpenAPI.SavedChart] {
        try await send(OpenAPIOperations.GetSavedCharts()).items.filter { !$0.name.hasPrefix("autochart:") }
    }
    public func saveChart(id: Int?, draft: CustomChartDraft) async throws -> OpenAPI.SavedChart {
        let body = try APIBody.encode(draft)
        if let id {
            return try await send(
                InsightRequest<OpenAPIOperations.UpdateSavedChart, OpenAPI.SavedChart>(
                    OpenAPIOperations.UpdateSavedChart(id: id, body: OpenAPIOperations.UpdateSavedChart.Body()),
                    query: [], bodyOverride: body))
        }
        return try await send(
            InsightRequest<OpenAPIOperations.CreateSavedChart, OpenAPI.SavedChart>(
                OpenAPIOperations.CreateSavedChart(body: OpenAPIOperations.CreateSavedChart.Body(name: draft.name)),
                query: [], bodyOverride: body))
    }
    public func deleteSavedChart(id: Int) async throws {
        _ = try await send(OpenAPIOperations.DeleteSavedChart(id: id))
    }
    public func customRecipientPivot(currency: String, draft: CustomChartDraft) async throws -> CustomRecipientPivot {
        var items = customPivotQuery(currency: currency, draft: draft)
        if !draft.allRecipients {
            items += draft.recipientIds.map { URLQueryItem(name: "recipient_ids", value: String($0)) }
        }
        return try await sendAggregation(
            OpenAPIOperations.GetRecipientPivot(), query: items)
    }
    public func customTagPivot(currency: String, draft: CustomChartDraft) async throws -> CustomTagPivot {
        var items = customPivotQuery(currency: currency, draft: draft)
        items.append(URLQueryItem(name: "all", value: draft.allTags ? "true" : "false"))
        if !draft.allTags { items += draft.tagIds.map { URLQueryItem(name: "tag_ids", value: String($0)) } }
        return try await sendAggregation(
            OpenAPIOperations.GetTagPivot(), query: items)
    }
    public func customChartRecipients() async throws -> [OpenAPI.Recipient] {
        try await send(OpenAPIOperations.GetRecipients(limit: 200, active: true)).items
    }
    public func customChartTags() async throws -> [OpenAPI.Tag] { try await tags() }
    private func customPivotQuery(currency: String, draft: CustomChartDraft) -> [URLQueryItem] {
        var result = [
            URLQueryItem(name: "currency", value: currency), URLQueryItem(name: "bucket", value: draft.timeBucket),
        ]
        if let start = draft.dateRangeStart { result.append(URLQueryItem(name: "start_date", value: start)) }
        if let end = draft.dateRangeEnd { result.append(URLQueryItem(name: "end_date", value: end)) }
        return result
    }
}
