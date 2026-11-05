import Foundation
import Testing

@testable import VisionNativeUI

struct ResearchDossierDateDisplayTests {
    @Test func utcPrefixIsReinterpretedAsLocalWallTimeOnEdit() throws {
        let zone = try #require(TimeZone(secondsFromGMT: 7200))
        let value = "2026-10-13T09:45:30.000Z"
        #expect(ResearchDossierDateDisplay.localPrefix(value) == "2026-10-13T09:45")
        let date = try #require(ResearchDossierDateDisplay.localDate(value, timeZone: zone))
        #expect(ISO8601DateFormatter().string(from: date) == "2026-10-13T07:45:00Z")
        #expect(ResearchDossierDateDisplay.localValue(date, timeZone: zone) == "2026-10-13T09:45")
    }
    @Test func emptyAndMalformedAccessDatesStayAbsent() {
        #expect(ResearchDossierDateDisplay.localDate(nil) == nil)
        #expect(ResearchDossierDateDisplay.localDate("") == nil)
        #expect(ResearchDossierDateDisplay.localDate("not-a-date") == nil)
    }
}
