import Foundation

/// An isolated graph holding captured values. Preparation never invokes a service or rebuilds
/// a saved-chart dataset; the renderer receives no references to the active page's models.
@MainActor public final class NativeStatisticsPrintPresentation {
    public let snapshot: NativeStatisticsPrintSnapshot
    public let shell: NativeShellModel
    public let screens: StatisticsScreens
    private init(snapshot: NativeStatisticsPrintSnapshot, shell: NativeShellModel, screens: StatisticsScreens) {
        self.snapshot = snapshot
        self.shell = shell
        self.screens = screens
    }
    public static func prepare(_ snapshot: NativeStatisticsPrintSnapshot) -> NativeStatisticsPrintPresentation {
        let inert = APIClient(baseURL: { nil })
        let rates = ExchangeRatesModel(service: inert)
        let admin = AdminScreens.make(
            service: inert, database: inert, token: .init(read: { nil }, write: { _ in false }))
        let shell = NativeShellModel(
            strings: snapshot.strings, theme: snapshot.theme, exchangeRates: rates, admin: admin,
            planned: PlannedPaymentsModel(
                service: inert, editing: inert, pickers: inert, rates: rates, dismissals: .memory()),
            imports: ImportsModel(service: inert, exports: inert, review: inert, pickers: inert),
            transactions: TransactionsModel(
                service: inert, attachments: inert, pickers: inert, bulk: inert, splits: inert),
            accounts: AccountsModel(service: inert, rates: rates), categories: CategoriesModel(service: inert),
            recipients: RecipientsModel(service: inert), loadSettings: { snapshot.settings }, onNavigate: { _ in })
        shell.apply(settings: snapshot.settings)
        let screens = StatisticsScreens(
            model: StatisticsModel(printSnapshot: snapshot), saved: SavedChartsModel(service: inert),
            digest: StatisticsDigestModel(printSnapshot: snapshot))
        return NativeStatisticsPrintPresentation(snapshot: snapshot, shell: shell, screens: screens)
    }
}

