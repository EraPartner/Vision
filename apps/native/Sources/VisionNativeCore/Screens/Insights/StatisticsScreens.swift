import Foundation

@MainActor
public struct StatisticsScreens {
    public let model: StatisticsModel
    public let saved: SavedChartsModel
    public let digest: StatisticsDigestModel
    public init(client: APIClient) {
        model = StatisticsModel(service: client)
        saved = SavedChartsModel(service: client)
        digest = StatisticsDigestModel(service: client)
    }
    public init(model: StatisticsModel, saved: SavedChartsModel, digest: StatisticsDigestModel) {
        self.model = model
        self.saved = saved
        self.digest = digest
    }
}
