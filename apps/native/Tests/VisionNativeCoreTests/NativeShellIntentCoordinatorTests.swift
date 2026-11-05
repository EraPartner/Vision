import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native session intent ownership")
struct NativeShellIntentCoordinatorTests {
    private let ready = NativeShellIntentCoordinator.Readiness(
        document: true, settings: true, onboarding: true, acceptingInput: true)

    private func file(_ name: String) -> ImportFile {
        ImportFile(name: name, data: Data("date,amount\n2026-01-01,1".utf8))
    }

    @Test func initialStartupMayWaitForSettingsButReplacementDoesNotCarryAnOldLeavePrompt() throws {
        let session = NativeShellIntentCoordinator()
        let target = try #require(NativeNavigationLocation("/admin/db"))
        var initial = NativeNavigationHistory()
        #expect(
            initial.request(.push(target), adminMode: nil, hasUnsavedChanges: false)
                == .waitingForSettings)
        let first = session.attach(initialHistory: initial)
        #expect(first.history.pending == .push(target))
        var resolved = first.history
        #expect(
            resolved.settingsDidLoad(adminMode: true, hasUnsavedChanges: false) == .committed(target))
        let next = try #require(NativeNavigationLocation("/transactions"))
        #expect(
            resolved.request(.push(next), adminMode: true, hasUnsavedChanges: true) == .blocked(next))
        session.checkpoint(resolved, for: first.lease)
        let second = session.attach(initialHistory: .init())
        #expect(second.history.location == target && second.history.pending == nil)
        #expect(second.history.count == 2 && second.history.canGoBack)
    }

    @Test func everyStartupGateHoldsActionsAndSourceEventOrderIsKept() {
        let session = NativeShellIntentCoordinator()
        let attachment = session.attach(initialHistory: .init())
        let intents: [NativeShellIntentCoordinator.Intent] = [
            .openSettings(section: "general"), .newTransaction, .newTransaction, .setTheme("dark"),
        ]
        for intent in intents { session.enqueue(intent) }
        var received: [NativeShellIntentCoordinator.Intent] = []
        for gate in [
            NativeShellIntentCoordinator.Readiness(
                document: false, settings: true, onboarding: true, acceptingInput: true),
            .init(document: true, settings: false, onboarding: true, acceptingInput: true),
            .init(document: true, settings: true, onboarding: false, acceptingInput: true),
            .init(document: true, settings: true, onboarding: true, acceptingInput: false),
        ] {
            session.drain(for: attachment.lease, readiness: gate) { received.append($0) }
        }
        #expect(received.isEmpty)
        session.drain(for: attachment.lease, readiness: ready) { received.append($0) }
        #expect(received == intents)
        #expect(!session.consumeNewTransaction(for: attachment.lease, consumerReady: false))
        #expect(session.consumeNewTransaction(for: attachment.lease, consumerReady: true))
        #expect(!session.consumeNewTransaction(for: attachment.lease, consumerReady: true))
        session.drain(for: attachment.lease, readiness: ready) { _ in Issue.record("Action replayed") }
    }

    @Test func coldFilesRegisterAfterReadinessThenLatestWinsAndConsumptionClears() {
        var clock = Date(timeIntervalSince1970: 1_000)
        let session = NativeShellIntentCoordinator(now: { clock })
        let attachment = session.attach(initialHistory: .init())
        let first = file("first.csv")
        let latest = file("latest.csv")
        session.enqueue(.openCSV(first))
        session.enqueue(.openCSV(latest))
        clock.addTimeInterval(600)
        #expect(session.consumeCSV(for: attachment.lease, consumerReady: true) == nil)
        session.drain(for: attachment.lease, readiness: ready) { _ in }
        #expect(session.consumeCSV(for: attachment.lease, consumerReady: false) == nil)
        clock.addTimeInterval(30)
        #expect(session.consumeCSV(for: attachment.lease, consumerReady: true) == latest)
        #expect(session.consumeCSV(for: attachment.lease, consumerReady: true) == nil)
    }

    @Test func reconstructionKeepsHistoryAndAbsoluteExpiryButRevokesTheOldGraph() throws {
        var clock = Date(timeIntervalSince1970: 1_000)
        let session = NativeShellIntentCoordinator(now: { clock })
        let first = session.attach(initialHistory: .init())
        var history = first.history
        let target = try #require(NativeNavigationLocation("/transactions?q=a+b&flag&raw=%2f"))
        _ = history.request(.push(target), adminMode: false, hasUnsavedChanges: false)
        _ = history.openSettings(section: "backup", adminMode: false)
        session.checkpoint(history, for: first.lease)
        session.enqueue(.openCSV(file("expired.csv")))
        session.drain(for: first.lease, readiness: ready) { _ in }
        clock.addTimeInterval(31)
        let second = session.attach(initialHistory: .init())
        #expect(second.history.location.raw == "/transactions?q=a+b&flag=&raw=%2F&settings=backup")
        #expect(second.history.count == 3 && second.history.index == 2)
        var resumed = second.history
        _ = resumed.closeSettings(adminMode: false)
        #expect(resumed.location == target && resumed.index == 1 && resumed.canGoForward)
        session.checkpoint(.init(), for: first.lease)
        #expect(!session.isCurrent(first.lease) && session.isCurrent(second.lease))
        #expect(session.consumeCSV(for: first.lease, consumerReady: true) == nil)
        #expect(session.consumeCSV(for: second.lease, consumerReady: true) == nil)
        session.enqueue(.newTransaction)
        session.drain(for: first.lease, readiness: ready) { _ in Issue.record("Retired graph drained") }
        var delivered: [NativeShellIntentCoordinator.Intent] = []
        session.drain(for: second.lease, readiness: ready) { delivered.append($0) }
        #expect(delivered == [.newTransaction])
        #expect(!session.consumeNewTransaction(for: first.lease, consumerReady: true))
        #expect(session.consumeNewTransaction(for: second.lease, consumerReady: true))
    }

    @Test func replacementDuringDispatchCannotReleaseMoreActionsToTheOldGraph() {
        let session = NativeShellIntentCoordinator()
        let first = session.attach(initialHistory: .init())
        session.enqueue(.newTransaction)
        session.enqueue(.openSettings(section: "appearance"))
        var second: NativeShellIntentCoordinator.Attachment?
        var oldActions: [NativeShellIntentCoordinator.Intent] = []
        session.drain(for: first.lease, readiness: ready) { intent in
            oldActions.append(intent)
            second = session.attach(initialHistory: .init())
        }
        #expect(oldActions == [.newTransaction])
        var newActions: [NativeShellIntentCoordinator.Intent] = []
        session.drain(for: second!.lease, readiness: ready) { newActions.append($0) }
        #expect(newActions == [.openSettings(section: "appearance")])
        #expect(session.consumeNewTransaction(for: second!.lease, consumerReady: true))
    }

    @Test func blockedColdNavigationReissuesOnlyTheDestinationWithoutRenewingFileExpiry() throws {
        var clock = Date(timeIntervalSince1970: 1_000)
        let session = NativeShellIntentCoordinator(now: { clock })
        let first = session.attach(initialHistory: .init())
        let target = try #require(NativeNavigationLocation("/import"))
        session.enqueue(.openCSV(file("blocked.csv")))
        session.drain(for: first.lease, readiness: ready) { _ in }
        var history = first.history
        _ = history.request(.push(target), adminMode: false, hasUnsavedChanges: true)
        session.checkpoint(history, for: first.lease)
        session.preserveBlockedColdNavigation(
            try #require(history.pending), newTransaction: false, for: first.lease)
        // A background settings publication must not cancel the still-identical blocker.
        session.checkpoint(history, for: first.lease)
        clock.addTimeInterval(31)
        let second = session.attach(initialHistory: .init())
        #expect(second.history.pending == nil && second.history.location == .home)
        var actions: [NativeShellIntentCoordinator.Intent] = []
        session.drain(for: second.lease, readiness: ready) { actions.append($0) }
        #expect(actions == [.navigate(target, replace: false)])
        #expect(session.consumeCSV(for: second.lease, consumerReady: true) == nil)
    }

    @Test func stayCancelsNewTransactionAndConsumedActionsDoNotReappearOnReplacement() {
        let session = NativeShellIntentCoordinator()
        let first = session.attach(initialHistory: .init())
        session.enqueue(.newTransaction)
        session.enqueue(.openCSV(file("chosen.csv")))
        session.drain(for: first.lease, readiness: ready) { _ in }
        session.cancelNewTransaction(for: first.lease)
        #expect(!session.consumeNewTransaction(for: first.lease, consumerReady: true))
        #expect(session.consumeCSV(for: first.lease, consumerReady: true) != nil)
        let second = session.attach(initialHistory: .init())
        session.drain(for: second.lease, readiness: ready) { _ in
            Issue.record("Consumed action replayed")
        }
        #expect(session.consumeCSV(for: second.lease, consumerReady: true) == nil)
        #expect(!session.consumeNewTransaction(for: second.lease, consumerReady: true))
    }
}
