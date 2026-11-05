import Foundation

public protocol ResearchChartBuilderService: ResearchService {
    func researchMacroSearch(query: String) async throws -> ResearchSnapshot<ResearchMacroSearchData>
    func researchMacroSeries(provider: String, seriesId: String, range: String) async throws -> ResearchSnapshot<
        ResearchMacroSeriesData
    >
}
extension APIClient: ResearchChartBuilderService {
    public func researchMacroSearch(query: String) async throws -> ResearchSnapshot<ResearchMacroSearchData> {
        let result = try await sendWithMeta(
            ResearchRequest<OpenAPIOperations.ResearchMacroSearch, ResearchMacroSearchData>(
                OpenAPIOperations.ResearchMacroSearch.self, query: [.init(name: "q", value: query)]))
        return .init(data: result.data, meta: .init(raw: result.meta))
    }
    public func researchMacroSeries(provider: String, seriesId: String, range: String) async throws -> ResearchSnapshot<
        ResearchMacroSeriesData
    > {
        let result = try await sendWithMeta(
            ResearchRequest<OpenAPIOperations.ResearchMacroSeries, ResearchMacroSeriesData>(
                OpenAPIOperations.ResearchMacroSeries.self,
                query: [
                    .init(name: "provider", value: provider), .init(name: "series_id", value: seriesId),
                    .init(name: "range", value: range),
                ]))
        return .init(data: result.data, meta: .init(raw: result.meta))
    }
}
