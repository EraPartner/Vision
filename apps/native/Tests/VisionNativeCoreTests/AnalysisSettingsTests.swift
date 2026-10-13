import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Application preferences consumed by Analysis")
struct AnalysisSettingsTests {
    @Test func storedPreferencesUseTheSameNormalizedDefaultsAsTheWeb() {
        let settings = NativeAppSettings.migrate(
            .object([
                "analysisBenchmark": .string(" vwce.de "), "aiAnswerDepth": .string("detailed"),
                "language": .string("nl"), "defaultCurrency": .string("CHF"),
            ]))
        #expect(settings.analysisBenchmark == "VWCE.DE")
        #expect(settings.aiAnswerDepth == "detailed")
        #expect(settings.language == "nl")
        #expect(settings.defaultCurrency == "CHF")
    }

    @Test func invalidAnalysisFieldsDoNotDiscardIndependentValidSettings() {
        let settings = NativeAppSettings.migrate(
            .object([
                "analysisBenchmark": .string("not a symbol!"), "aiAnswerDepth": .string("long"),
                "language": .string("de"), "defaultCurrency": .string("eur"), "defaultPageSize": .int(100),
            ]))
        #expect(settings.analysisBenchmark == nil)
        #expect(settings.aiAnswerDepth == "quick")
        #expect(settings.language == "en")
        // The stored currency remains case-preserving; Analysis resolves its stricter preference layer.
        #expect(settings.defaultCurrency == "eur")
        #expect(settings.defaultPageSize == 100)
    }
}
