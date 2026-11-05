import Foundation

/// Isolated presentation graph for existing section views. Its only services return frozen values;
/// the inert API client has no backend URL, and local dismissal storage is in memory.
@MainActor public final class NativeTaxPrintPresentation {
    public let snapshot: NativeTaxPrintSnapshot
    public let shell: NativeShellModel
    public let dashboard: TaxDashboardModel
    public let deductions: TaxDeductionsModel
    public let actions: TaxActionsModel
    private init(
        snapshot: NativeTaxPrintSnapshot, shell: NativeShellModel, dashboard: TaxDashboardModel,
        deductions: TaxDeductionsModel, actions: TaxActionsModel
    ) {
        self.snapshot = snapshot
        self.shell = shell
        self.dashboard = dashboard
        self.deductions = deductions
        self.actions = actions
    }
    public static func prepare(_ snapshot: NativeTaxPrintSnapshot) async throws -> NativeTaxPrintPresentation {
        let inert = APIClient(baseURL: { nil })
        let rates = ExchangeRatesModel(service: inert)
        let admin = AdminScreens.make(service: inert, database: inert)
        let shell = NativeShellModel(
            strings: snapshot.strings, theme: snapshot.theme, exchangeRates: rates, admin: admin,
            planned: PlannedPaymentsModel(
                service: inert, editing: inert, pickers: inert, rates: rates, dismissals: .memory()),
            imports: ImportsModel(service: inert, exports: inert, review: inert, pickers: inert),
            transactions: TransactionsModel(
                service: inert, attachments: inert, pickers: inert, bulk: inert, splits: inert),
            accounts: AccountsModel(service: inert, rates: rates), categories: CategoriesModel(service: inert),
            recipients: RecipientsModel(service: inert), loadSettings: { snapshot.settings })
        shell.apply(settings: snapshot.settings)
        let dashboard = TaxDashboardModel(service: NativeTaxPrintDashboard(data: snapshot.dashboard))
        await dashboard.load(year: snapshot.year, currency: snapshot.dashboard.currency)
        guard dashboard.data?.year == snapshot.year, dashboard.error == nil else {
            throw APIError.invalidRequest("Frozen Tax print data unavailable")
        }
        let deductions = TaxDeductionsModel(service: NativeTaxPrintDeductions(snapshot: snapshot))
        if let data = snapshot.deductionData {
            await deductions.load(year: data.year)
            for group in deductions.groups where snapshot.appliedDeductionTypes.contains(group.deductionType) {
                _ = await deductions.apply(group) { _ in true }
            }
        }
        let overview = TaxOverviewModel(service: inert)
        let actions = TaxActionsModel(overview: overview, computations: inert, settings: inert)
        return NativeTaxPrintPresentation(
            snapshot: snapshot, shell: shell, dashboard: dashboard, deductions: deductions, actions: actions)
    }
}

private struct NativeTaxPrintDashboard: TaxDashboardService {
    let data: TaxDashboardData
    func homeExclusions(scope: String) async throws -> InsightExclusions { .init() }
    func taxDashboard(year: Int?, query: StatisticsQuery) async throws -> TaxDashboardData { data }
}
private struct NativeTaxPrintDeductions: TaxDeductionsService {
    let snapshot: NativeTaxPrintSnapshot
    func deductionCandidates(year: Int) async throws -> TaxDeductionCandidates {
        if let error = snapshot.deductionError { throw APIError.network(error) }
        guard let data = snapshot.deductionData else { throw APIError.backendUnavailable }
        return TaxDeductionCandidates(
            year: data.year, from: data.from, to: data.to, currency: data.currency,
            byDeductionType: snapshot.deductionGroups)
    }
}
