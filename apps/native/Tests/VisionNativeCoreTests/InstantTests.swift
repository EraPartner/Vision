import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct InstantTests {
    /// 2024-01-15T10:30:00Z.
    private let reference = Date(timeIntervalSince1970: 1_705_314_600)

    @Test func parsesTimestampsWithAndWithoutFractionalSeconds() throws {
        let plain = try #require(Instant(String("2024-01-15T10:30:00Z")))
        #expect(plain.date == reference)
        let millis = try #require(Instant(String("2024-01-15T10:30:00.500Z")))
        #expect(abs(millis.date.timeIntervalSince(reference) - 0.5) < 0.000_001)
        let micros = try #require(Instant(String("2024-01-15T10:30:00.123456+00:00")))
        #expect(abs(micros.date.timeIntervalSince(reference) - 0.123456) < 0.000_001)
    }

    @Test func offsetsAreAppliedToTheInstant() throws {
        let plus = try #require(Instant(String("2024-01-15T12:30:00+02:00")))
        #expect(plus.date == reference)
        let minus = try #require(Instant(String("2024-01-15T05:30:00-05:00")))
        #expect(minus.date == reference)
        let compact = try #require(Instant(String("2024-01-15T12:30:00+0200")))
        #expect(compact.date == reference)
        let hoursOnly = try #require(Instant(String("2024-01-15T12:30:00+02")))
        #expect(hoursOnly.date == reference)
    }

    @Test func thePostgresTextFormIsAccepted() throws {
        let spaced = try #require(Instant(String("2024-01-15 10:30:00+00")))
        #expect(spaced.date == reference)
        let noSeconds = try #require(Instant(String("2024-01-15T10:30Z")))
        #expect(noSeconds.date == reference)
    }

    @Test func aTimestampWithoutAZoneOrWithABadFieldIsRejected() {
        let rejected = [
            "", "yesterday", "2024-01-15", "2024-01-15T10:30:00", "2024-01-15T10:30:00.5",
            "2024-01-15T25:00:00Z", "2024-01-15T10:60:00Z", "2024-02-30T10:30:00Z",
            "2024-01-15T10:30:00Zjunk",
        ]
        for text in rejected {
            #expect(Instant(text) == nil, "\(text) should be rejected")
        }
        #expect(throws: InstantError.invalid("nope")) {
            _ = try Instant(validating: "nope")
        }
    }

    @Test func theTextItWasReadFromIsWhatIsEncoded() throws {
        let texts = [
            "2024-01-15T10:30:00Z", "2024-01-15T10:30:00.123456+00:00",
            "2024-01-15T12:30:00+02:00", "2024-01-15 10:30:00+00",
        ]
        for text in texts {
            let data = Data("\"\(text)\"".utf8)
            let decoded = try JSONDecoder().decode(Instant.self, from: data)
            #expect(decoded.text == text)
            #expect(decoded.description == text)
            #expect(try JSONEncoder().encode(decoded) == data)
        }
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(Instant.self, from: Data("\"2024-01-15T10:30:00\"".utf8))
        }
    }

    @Test func equalityAndOrderCompareTheInstantNotTheText() throws {
        let utc = try #require(Instant(String("2024-01-15T10:30:00Z")))
        let offset = try #require(Instant(String("2024-01-15T12:30:00+02:00")))
        let later = try #require(Instant(String("2024-01-15T10:30:01Z")))
        #expect(utc == offset)
        #expect(utc.hashValue == offset.hashValue)
        #expect(utc.text != offset.text)
        #expect(utc < later)
        #expect(Set([utc, offset]).count == 1)
    }

    @Test func theWrittenDayIsTheDayBeforeAnyZoneConversion() throws {
        let evening = try #require(Instant(String("2024-01-15T23:30:00-05:00")))
        #expect(evening.writtenDay.description == "2024-01-15")
        #expect(evening.date == reference.addingTimeInterval(18 * 3600))
        let utc = try #require(Instant(String("2024-01-15T00:00:00.000Z")))
        #expect(utc.writtenDay.description == "2024-01-15")
    }

    @Test func anInstantMadeFromADateIsWrittenInCanonicalUTC() {
        let made = Instant(date: reference.addingTimeInterval(0.25))
        #expect(made.text == "2024-01-15T10:30:00.250Z")
        #expect(made.writtenDay.description == "2024-01-15")
        #expect(Instant(made.text) == made)
    }

    @Test func anInstantInAQueryIsItsWireText() throws {
        let instant = try #require(Instant(String("2024-01-15T10:30:00Z")))
        #expect(APIQuery.value(instant) == "2024-01-15T10:30:00Z")
    }
}
