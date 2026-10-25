import Foundation

/// `monthlyRentInTarget` (hooks/portfolio/monthlyRent.ts): the latest rent remains a transaction
/// amount in its booking currency, converted to the display currency.
public enum PortfolioMonthlyRent {
    /// `0` without any rent; `nil` when the rent's currency has no rate.
    public static func inTarget(
        _ transactions: [PortfolioTransaction], originalCurrency: String?,
        convert: (Decimal, String) -> Decimal?
    ) -> Decimal? {
        // Newest date first, then the higher id, as the source's sort.
        guard let rent = transactions.filter({ $0.type == "rent_income" }).max(by: { ($0.date, $0.id) < ($1.date, $1.id) })
        else { return 0 }
        let fallback = originalCurrency.flatMap { $0.isEmpty ? nil : $0 } ?? "EUR"
        return convert(rent.amount, rent.currency.isEmpty ? fallback : rent.currency)
    }
}
