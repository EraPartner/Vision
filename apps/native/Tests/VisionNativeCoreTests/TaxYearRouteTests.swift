import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Tax year URL adoption and canonicalization")
struct TaxYearRouteTests {
    @Test func acceptsExactlyFourASCIIDigits() {
        #expect(TaxYearRoute.parse("2024") == 2024)
        #expect(TaxYearRoute.parse("1994") == 1994)
        #expect(TaxYearRoute.parse("0000") == 0)
        #expect(TaxYearRoute.parse(nil) == nil)
        #expect(TaxYearRoute.parse("") == nil)
    }

    @Test(arguments: [
        "2024 ", " 2024", "+2024", "-2024", "2024.0", "2e03", "20240", "024", "20x4", "２０２４", "٢٠٢٤", "2024\n",
        "%32%30%32%34",
    ])
    func rejectsNonCanonicalYearTokens(_ raw: String) {
        #expect(TaxYearRoute.parse(raw) == nil)
    }

    @Test func validRangeIncludesBothBoundariesButRejectsTheirNeighbours() throws {
        func resolve(_ year: Int) throws -> Int {
            TaxYearRoute.selectedYear(
                route: try #require(NativeRoute("/tax?year=\(year)")), liveYear: 2024, snapshotYears: [])
        }
        #expect(try resolve(1994) == 1994)
        #expect(try resolve(2025) == 2025)
        #expect(try resolve(1993) == 2024)
        #expect(try resolve(2026) == 2024)
    }

    @Test func storedSnapshotsAreAcceptedOutsideTheLiveWindow() throws {
        let old = try #require(NativeRoute("/portfolio/tax?year=1980"))
        let future = try #require(NativeRoute("/portfolio/tax?year=2030"))
        #expect(TaxYearRoute.selectedYear(route: old, liveYear: 2024, snapshotYears: [1980]) == 1980)
        #expect(TaxYearRoute.selectedYear(route: future, liveYear: 2024, snapshotYears: [2030]) == 2030)
        #expect(TaxYearRoute.selectedYear(route: old, liveYear: 2024, snapshotYears: [2030]) == 2024)
    }

    @Test func missingOrInvalidYearPreservesAnExistingViewedYear() throws {
        for raw in ["/tax", "/tax?year=not-a-year", "/tax?year=2100", "/tax?year="] {
            let route = try #require(NativeRoute(raw))
            #expect(
                TaxYearRoute.selectedYear(route: route, liveYear: 2024, snapshotYears: [], fallbackYear: 2021) == 2021)
        }
        let requested = try #require(NativeRoute("/tax?year=2020"))
        #expect(
            TaxYearRoute.selectedYear(route: requested, liveYear: 2024, snapshotYears: [], fallbackYear: 2021) == 2020)
    }

    @Test func canonicalRoutePreservesPathUnrelatedParametersAndTheirDuplicates() throws {
        let route = try #require(NativeRoute("/portfolio/tax?filter=one&year=1993&keep=a%2Bb&year=2020&filter=two"))
        let canonical = TaxYearRoute.canonicalRoute(route: route, liveYear: 2024, snapshotYears: [])
        #expect(canonical.path == "/portfolio/tax")
        #expect(
            canonical.query == [
                URLQueryItem(name: "filter", value: "one"), URLQueryItem(name: "year", value: "2024"),
                URLQueryItem(name: "keep", value: "a+b"), URLQueryItem(name: "filter", value: "two"),
            ])
        #expect(TaxYearRoute.canonicalRoute(route: canonical, liveYear: 2024, snapshotYears: []) == canonical)
    }

    @Test func aMissingYearIsAppendedAndTheAuthoritativeLiveYearIsUsed() throws {
        let route = try #require(NativeRoute("/tax?currency=USD&view=household"))
        let canonical = TaxYearRoute.canonicalRoute(route: route, liveYear: 2022, snapshotYears: [])
        #expect(canonical.string == "/tax?currency=USD&view=household&year=2022")
    }

    @Test func decodingUsesTheFirstYearBeforeMirrorRemovesDuplicates() throws {
        let route = try #require(NativeRoute("/tax?year=%32%30%32%33&year=2024"))
        let canonical = TaxYearRoute.canonicalRoute(route: route, liveYear: 2024, snapshotYears: [])
        #expect(canonical.string == "/tax?year=2023")
    }
}
