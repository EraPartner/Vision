import Foundation

/// The tax-only URL adoption and mirror rules from useTaxYearParam.ts.
public enum TaxYearRoute {
    public static let maximumYearsBack = 30

    /// URLSearchParams decoding happens in NativeRoute; the resulting value must be four ASCII digits.
    public static func parse(_ raw: String?) -> Int? {
        guard let raw, raw.utf8.count == 4, raw.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return Int(raw)
    }

    /// `fallbackYear` is the provider's already-viewed year, when there is one. A fresh
    /// provider falls back to the authoritative live profile year, rather than a local clock.
    public static func selectedYear(
        route: NativeRoute, liveYear: Int, snapshotYears: Set<Int>, fallbackYear: Int? = nil
    ) -> Int {
        guard let requested = parse(route.value("year")),
            snapshotYears.contains(requested)
                || (requested >= liveYear - maximumYearsBack && requested <= liveYear + 1)
        else { return fallbackYear ?? liveYear }
        return requested
    }

    /// Mirrors the accepted year using replace semantics, retaining every unrelated query
    /// item. Like URLSearchParams.set, all duplicate year parameters collapse into the first.
    public static func canonicalRoute(
        route: NativeRoute, liveYear: Int, snapshotYears: Set<Int>, fallbackYear: Int? = nil
    ) -> NativeRoute {
        route.setting(
            "year",
            to: String(
                selectedYear(route: route, liveYear: liveYear, snapshotYears: snapshotYears, fallbackYear: fallbackYear)
            ))
    }
}
