import Testing

@testable import VisionNativeCore

@Suite struct NativeRendererReadinessTests {
    @Test func oldStartupCannotResumeAfterTheNextDocumentBecomesReady() throws {
        var readiness = NativeRendererReadiness()
        let firstStartupReceipt = readiness.markReady()
        let firstStartup = try #require(firstStartupReceipt)
        #expect(readiness.isCurrentReady(firstStartup))

        // An awaited startup read belongs to the outgoing document. Testing only
        // isReady would admit its continuation once the new document answers.
        readiness.documentDidCommit()
        #expect(!readiness.isReady)
        #expect(!readiness.isCurrentReady(firstStartup))
        let replacementStartupReceipt = readiness.markReady()
        let replacementStartup = try #require(replacementStartupReceipt)
        #expect(readiness.isReady)
        #expect(!readiness.isCurrentReady(firstStartup))
        #expect(readiness.isCurrentReady(replacementStartup))
    }

    @Test func duplicateReadyReceiptsDoNotRetireStartupForTheSameDocument() throws {
        var readiness = NativeRendererReadiness()
        let originalReceipt = readiness.markReady()
        let original = try #require(originalReceipt)
        let duplicateReceipt = readiness.markReady()
        let duplicate = try #require(duplicateReceipt)
        #expect(original == duplicate)
        #expect(readiness.isCurrentReady(original))
    }

    @Test func lateOutgoingReceiptCannotAuthorizeThePendingReload() throws {
        var readiness = NativeRendererReadiness()
        let outgoingReceipt = readiness.markReady()
        let outgoing = try #require(outgoingReceipt)
        readiness.willNavigate()
        #expect(readiness.isAwaitingCommit)
        let rejectedBeforeDrain = readiness.markReady()
        #expect(rejectedBeforeDrain == nil)
        #expect(!readiness.isReady)

        // The host invalidates again after the drain, immediately before reload.
        // Ready messages can still arrive from the outgoing WebKit document here.
        readiness.willNavigate()
        let rejectedBeforeCommit = readiness.markReady()
        #expect(rejectedBeforeCommit == nil)
        #expect(!readiness.isReady)
        #expect(!readiness.isCurrentReady(outgoing))

        readiness.documentDidCommit()
        #expect(!readiness.isAwaitingCommit)
        #expect(!readiness.isReady)
        let incomingReceipt = readiness.markReady()
        let incoming = try #require(incomingReceipt)
        #expect(readiness.isCurrentReady(incoming))
        #expect(!readiness.isCurrentReady(outgoing))
    }
}
