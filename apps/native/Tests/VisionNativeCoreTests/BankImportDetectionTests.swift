import Foundation
import Testing

@testable import VisionNativeCore

private func parser(_ id: Int, _ name: String, separator: String = ",", skipRows: Int = 0) -> OpenAPI.CustomParserConfig {
    OpenAPI.CustomParserConfig(
        id: CustomParserConfigID(id), name: name,
        config: OpenAPI.TransactionParserConfig(
            dateColumn: "Booked", recipientColumn: "Payee", amountColumn: "Value", separator: separator,
            skipRows: skipRows))
}

private let savedCSV = Data("Booked,Payee,Value\n2026-10-01,Bakery,-4.50\n".utf8)
private let revolutCSV = Data(
    "\u{FEFF}Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n".utf8)

/// ADR-268 (bankImportDetection.test): the shared signatures and how a result resolves.
@Suite("Bank import detection")
struct BankImportDetectorTests {
    @Test func signaturesMatchTheirExportsInRegistryOrder() {
        #expect(BankImportDetector.formats(String(decoding: revolutCSV, as: UTF8.self)) == [.revolut])
        #expect(BankImportDetector.formats("Rekeningnummer;Rubrieknaam\n") == [.kbc])
        // An ING header also starts with KBC's "Rekeningnummer"; ING comes first.
        #expect(
            BankImportDetector.formats("Rekeningnummer;Omzetnummer;Detail van de omzet\n") == [.ing, .kbc])
        #expect(BankImportDetector.formats("Date,Bank account,Recipient,Memo,Amount,Currency,Balance\r\n") == [.vision])
        #expect(BankImportDetector.formats("Date,Amount,Bank account,Recipient\n").isEmpty)
        let belfius = "BE68539007547034;" + Array(repeating: "x", count: 11).joined(separator: ";")
        #expect(BankImportDetector.formats("Header\n\(belfius)\n") == [.belfius])
        #expect(BankImportDetector.formats(nil).isEmpty)
    }

    @Test func aSavedParserFitsWhenEveryMappedColumnIsInItsHeaderRow() {
        #expect(BankImportDetector.matchesSavedParser(headers: [" Booked", "Payee ", "Value"], columns: ["Booked", "Payee", "Value", ""]))
        #expect(!BankImportDetector.matchesSavedParser(headers: ["Booked", "Payee"], columns: ["Booked", "Payee", "Value", ""]))
        #expect(!BankImportDetector.matchesSavedParser(headers: ["Booked", "Payee"], columns: ["Booked", "Payee", "", ""]))
    }

    @Test func builtInsWinAloneOneSavedParserWinsAloneAndOverlapsAreNotGuessed() {
        #expect(BankImportDetector.resolve(formats: [.ing, .kbc], saved: []) == .detected(.adapter("ing")))
        #expect(BankImportDetector.resolve(formats: [], saved: []) == .none)
        #expect(BankImportDetector.resolve(formats: [], saved: [.saved(3)]) == .detected(.saved(3)))
        #expect(
            BankImportDetector.resolve(formats: [.kbc], saved: [.saved(3)]) == .ambiguous([.adapter("kbc"), .saved(3)]))
        #expect(BankImportDetector.resolve(formats: [], saved: [.saved(3), .saved(4)]) == .ambiguous([.saved(3), .saved(4)]))
    }

    @Test func savedParsersReadTheFileWithTheirOwnSeparatorAndSkippedRows() {
        #expect(BankImportDetector.detect(savedCSV, savedParsers: [parser(3, "Mine")]) == .detected(.saved(3)))
        #expect(BankImportDetector.detect(savedCSV, savedParsers: [parser(3, "Mine", separator: ";")]) == .none)
        #expect(BankImportDetector.detect(savedCSV, savedParsers: [parser(3, "Mine", skipRows: 1)]) == .none)
        #expect(BankImportDetector.detect(revolutCSV, savedParsers: [parser(3, "Mine")]) == .detected(.adapter("revolut")))
    }
}

@MainActor
@Suite("Bank import card detection")
struct BankImportCardDetectionTests {
    @Test func detectAutomaticallyUsesTheRecognisedBankAndNamesIt() async {
        let model = ImportFixture.model(FakeImportService(adapters: ImportFixture.adapters + [
            ImportAdapter(key: "revolut", name: "Revolut", adapterClass: "RevolutAdapter")
        ]))
        await model.appear(strings: ImportFixture.strings)
        #expect(model.selection == .auto)
        model.chooseFile(ImportFile(name: "revolut.csv", data: revolutCSV, mimeType: "text/csv"))
        #expect(model.source == .adapter("revolut"))
        #expect(model.resolvedBank == "revolut")
        #expect(model.hintKey == nil)
        let strings = DictionaryStrings(language: .en, table: ["importPage.detect.found": "Recognised as {name}."])
        #expect(model.detectionStatus(strings) == "Recognised as Revolut.")
        // Choosing a bank by hand ends detection; going back to auto detects again.
        model.selectSource(.adapter("kbc"))
        #expect(model.source == .adapter("kbc") && model.detectionStatus(strings) == nil)
        model.selectSource(.auto)
        #expect(model.source == .adapter("revolut"))
    }

    @Test func aRecognisedSavedParserLoadsItsSetupAndEditPinsIt() async {
        let model = ImportFixture.model(FakeImportService(parsers: [parser(3, "Mine")]))
        model.chooseFile(ImportFile(name: "mine.csv", data: savedCSV, mimeType: "text/csv"))
        // The saved parsers are candidates once they load.
        #expect(model.source == nil && model.hintKey == "importPage.hint.bank")
        await model.appear(strings: ImportFixture.strings)
        #expect(model.source == .saved(3))
        #expect(model.parserName == "Mine" && model.config.amountColumn == "Value")
        #expect(model.showsSavedSummary && !model.isParserDirty)
        model.startEditing()
        #expect(model.selection == .saved(3) && model.showsEditor)
        model.removeFile()
        #expect(model.source == .saved(3))
    }

    @Test func aFileThatFitsSeveralSetupsWaitsForAChoice() async {
        let model = ImportFixture.model(FakeImportService(parsers: [parser(3, "Mine"), parser(4, "Other")]))
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFile(name: "mine.csv", data: savedCSV, mimeType: "text/csv"))
        #expect(model.detection == .ambiguous([.saved(3), .saved(4)]))
        #expect(model.source == nil && model.hintKey == "importPage.hint.bank")
        let strings = DictionaryStrings(language: .en, table: ["importPage.detect.ambiguous": "Fits {names}."])
        #expect(model.detectionStatus(strings) == "Fits Mine, Other.")
    }
}
