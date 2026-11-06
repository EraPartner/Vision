import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct LiteralsTests {
    @Test func decimalLiteralIsExact() {
        #expect(Decimal.literal("0.005") == Decimal(sign: .plus, exponent: -3, significand: 5))
        #expect(Decimal.literal("7.5") == Decimal(75) / 10)
        #expect(Decimal.literal("1234.567").description == "1234.567")
    }

    @Test func urlLiteralKeepsTheSourceText() {
        #expect(URL.literal("https://ollama.com/download").absoluteString == "https://ollama.com/download")
    }

    @Test func temporaryDirectoryPathHasNoTemplateSuffix() throws {
        let path = try BackupFiles.makeTemporaryDirectory(prefix: "vision-literals-")
        defer { try? FileManager.default.removeItem(atPath: path) }
        #expect(!path.hasSuffix("XXXXXX"))
        #expect(FileManager.default.fileExists(atPath: path))
    }
}
