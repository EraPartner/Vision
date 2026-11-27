import Foundation
import Testing

@testable import VisionNativeCore

/// Regression tests for the native findings of Astra bug report 1 (2026-11-27) that have no
/// closer home.
@MainActor
@Suite struct AstraReportCoreTests {
    /// A splits service that answers nothing; the split dialog's share math needs no reads.
    private struct SilentSplits: SplitsService {
        func splits(transactionId: TransactionID) async throws -> [OpenAPI.Split] { [] }
        func createSplits(transactionId: TransactionID, shares: [SplitShare]) async throws {}
        func bulkSplit(transactionIds: [TransactionID], recipientId: RecipientID, mode: BulkSplitMode) async throws
            -> OpenAPI.BulkSplitResult
        { throw CancellationError() }
        func owedSummary(currency: CurrencyCode) async throws -> OwedSummaryPage { throw CancellationError() }
        func owed(recipientId: RecipientID, currency: CurrencyCode) async throws -> OwedDetailPage {
            throw CancellationError()
        }
        func exportOwedCsv(recipientId: RecipientID) async throws -> Data { Data() }
        func recordPayment(splitId: SplitID, amount: Decimal) async throws {}
        func settle(splitId: SplitID) async throws {}
        func settleAll(recipientId: RecipientID) async throws -> Int { 0 }
        func deleteSplit(id: SplitID) async throws {}
        func recipientTransactions(groupId: RecipientGroupID, offset: Int, limit: Int) async throws -> TransactionPage {
            throw CancellationError()
        }
    }

    /// Finding 51: €5 split eight ways is four shares of €0.63 and four of €0.62, so the payer
    /// pays at most one cent more than anyone else.
    @Test func equalSplitSharesDifferByAtMostOneCent() throws {
        let row = TransactionRow(TxFixture.wire(id: 1, amount: -5))
        let model = SplitDialogModel(row: row, service: SilentSplits())
        for _ in 1..<7 { model.addEntry() }
        for (index, entry) in model.entries.enumerated() {
            model.setRecipient(entry.id, to: RecipientID(rawValue: index + 10))
        }
        #expect(model.totalPeople == 8)
        let shares = try #require(model.shares(format: .eu)).map(\.amount)
        #expect(shares.count == 7)
        let payer = 5 - shares.reduce(Decimal(0), +)
        let all = shares + [payer]
        #expect(all.reduce(Decimal(0), +) == 5)
        #expect((all.max() ?? 0) - (all.min() ?? 0) <= Decimal(string: "0.01")!)
    }

    /// A Keychain item that exists but refuses to be read.
    private struct LockedPassphraseStore: PassphraseStore {
        func read() throws -> String? { throw KeychainError(status: -25_293) }
        func write(_ passphrase: String) throws {}
        func delete() throws {}
        func contains() -> Bool { true }
    }

    /// Finding 24: a stored passphrase the Keychain will not return blocks an unencrypted backup.
    @Test func anUnreadableStoredPassphraseIsNotTreatedAsNone() {
        #expect(BackupPassphrase.isStoredButUnreadable(store: LockedPassphraseStore()))
        #expect(!BackupPassphrase.isStoredButUnreadable(store: InMemoryPassphraseStore("stored")))
        #expect(!BackupPassphrase.isStoredButUnreadable(store: InMemoryPassphraseStore()))
        #expect(!BackupPassphrase.isStoredButUnreadable(store: nil))
    }
}
