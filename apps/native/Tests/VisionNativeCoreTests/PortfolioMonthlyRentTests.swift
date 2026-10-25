import Foundation
import Testing

@testable import VisionNativeCore

/// Mirrors hooks/portfolio/__tests__/monthlyRent.test.ts.
@Suite struct PortfolioMonthlyRentTests {
    private func rent(id: Int, date: String, amount: Int, currency: String) throws -> PortfolioTransaction {
        let value =
            "{\"id\":\(id),\"investment_id\":5,\"type\":\"rent_income\",\"date\":\"\(date)\",\"amount\":\(amount),\"currency\":\"\(currency)\",\"is_recurring\":false,\"created_at\":\"\(date)\",\"updated_at\":\"\(date)\",\"income_recognition_role\":\"standard\",\"dividend_amount_convention\":\"unknown\"}"
        return try JSONDecoder().decode(PortfolioTransaction.self, from: Data(value.utf8))
    }
    private let convert: (Decimal, String) -> Decimal? = { amount, currency in
        currency == "EUR" ? amount : currency == "USD" ? amount * Decimal(string: "0.8")! : nil
    }

    @Test func convertsTheMostRecentForeignRent() throws {
        let rows = [
            try rent(id: 1, date: "2026-01-01", amount: 500, currency: "EUR"),
            try rent(id: 2, date: "2026-02-01", amount: 1000, currency: "USD"),
        ]
        #expect(PortfolioMonthlyRent.inTarget(rows, originalCurrency: "USD", convert: convert) == 800)
    }

    @Test func keepsSameCurrencyRentAndFallsBackToTheOriginalCurrency() throws {
        let euro = [try rent(id: 1, date: "2026-01-01", amount: 1000, currency: "EUR")]
        #expect(PortfolioMonthlyRent.inTarget(euro, originalCurrency: "USD", convert: convert) == 1000)
        let unlabelled = [try rent(id: 1, date: "2026-01-01", amount: 1000, currency: "")]
        #expect(PortfolioMonthlyRent.inTarget(unlabelled, originalCurrency: "USD", convert: convert) == 800)
    }

    @Test func distinguishesMissingRatesFromZeroRent() throws {
        let foreign = [try rent(id: 1, date: "2026-01-01", amount: 1000, currency: "XYZ")]
        #expect(PortfolioMonthlyRent.inTarget(foreign, originalCurrency: "USD", convert: convert) == nil)
        #expect(PortfolioMonthlyRent.inTarget([], originalCurrency: "USD", convert: convert) == 0)
    }

    @Test func sameDateRentUsesTheHigherId() throws {
        let rows = [
            try rent(id: 7, date: "2026-03-01", amount: 1000, currency: "USD"),
            try rent(id: 3, date: "2026-03-01", amount: 500, currency: "EUR"),
        ]
        #expect(PortfolioMonthlyRent.inTarget(rows, originalCurrency: nil, convert: convert) == 800)
    }
}
