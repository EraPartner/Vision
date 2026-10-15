import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeHelperDocumentSessionTests {
    typealias Session = NativeHelperDocumentSession

    private func source(
        debug: Bool = true, variant: String? = "demo", runtime: String = "vision_native_demo",
        origin: String = "http://127.0.0.1:49123", store: String = "expected-default-store"
    ) throws -> Session.Source {
        try .init(
            isDebugBuild: debug, rawVariant: variant,
            supervisorReceipt: .init(runtimeIdentifier: runtime, backendOrigin: URL(string: origin)!),
            websiteDataStoreIdentifier: store)
    }

    private func observation(
        _ source: Session.Source, _ navigation: UUID, url: URL? = nil,
        store: String? = nil, main: Bool = true, origin: URL? = nil
    ) -> Session.Observation {
        .init(
            navigationID: navigation, documentURL: url ?? source.helperURL,
            websiteDataStoreIdentifier: store ?? source.websiteDataStoreIdentifier,
            isMainFrame: main, securityOrigin: origin ?? source.backendOrigin)
    }

    @Test func eligibilityRequiresExactDebugDemoAndSupervisorReceipt() throws {
        for variant in [nil, "standard", "Demo", "demo ", "unknown"] as [String?] {
            #expect(throws: Session.SessionError.ineligibleSession) { try source(variant: variant) }
        }
        #expect(throws: Session.SessionError.ineligibleSession) { try source(debug: false) }
        #expect(throws: Session.SessionError.ineligibleSession) { try source(runtime: "vision_demo") }
        #expect(throws: Session.SessionError.ineligibleSession) {
            try source(runtime: "developer-override")
        }
        let valid = try source()
        #expect(valid.helperURL.absoluteString == "http://127.0.0.1:49123/native-helper.html")
    }

    @Test func originMustBeLoopbackOriginOnlyAndStoreExplicit() throws {
        for origin in [
            "https://example.com", "file:///tmp", "http://127.0.0.1:49123/app",
            "http://127.0.0.1:49123/?", "http://127.0.0.1:49123/#",
            "http://user@127.0.0.1:49123", "http://@127.0.0.1:49123", "http://127.0.0.1:0",
        ] {
            #expect(throws: Session.SessionError.invalidSource) { try source(origin: origin) }
        }
        #expect(throws: Session.SessionError.invalidSource) { try source(store: " ") }
        let valid = try source(origin: "http://localhost:80/")
        #expect(valid.helperURL.absoluteString == "http://localhost/native-helper.html")
        #expect(valid.acceptsSecurityOrigin(URL(string: "http://localhost")!))
        #expect(!valid.acceptsSecurityOrigin(URL(string: "https://localhost:80")!))
        #expect(!valid.acceptsSecurityOrigin(URL(string: "http://127.0.0.1:80")!))
    }

    @Test func canonicalHelperURLCannotAliasASpaRouteOrAnotherStore() throws {
        let source = try source()
        for path in [
            "/", "/native-helper.html?", "/native-helper.html#", "/Native-helper.html",
            "/native-helper.html/", "/%6eative-helper.html", "/other/../native-helper.html",
        ] {
            let url = URL(string: source.backendOrigin.absoluteString + path)!
            #expect(
                !source.accepts(
                    documentURL: url, websiteDataStoreIdentifier: source.websiteDataStoreIdentifier))
        }
        #expect(
            !source.accepts(documentURL: source.helperURL, websiteDataStoreIdentifier: "foreign-store"))
        #expect(
            !source.accepts(
                documentURL: URL(string: "http://127.0.0.1:49124/native-helper.html")!,
                websiteDataStoreIdentifier: source.websiteDataStoreIdentifier))
    }

    @Test func readyRequiresCommitFinishAndBothIndependentReceipts() throws {
        let source = try source()
        var session = Session(source: source, generationID: UUID())
        let navigation = UUID()
        let evidence = observation(source, navigation)
        try session.beginNavigation(navigation)
        let early = try #require(session.provenance)
        #expect(throws: Session.SessionError.invalidPhase) {
            try session.acceptCallback(.ready(early), observation: evidence)
        }
        #expect(throws: Session.SessionError.invalidPhase) { try session.didFinish(evidence) }
        try session.didCommit(evidence)
        #expect(throws: Session.SessionError.invalidPhase) {
            try session.acceptCallback(.ready(early), observation: evidence)
        }
        let issued = try session.didFinish(evidence)
        try session.acceptCallback(.ready(issued), observation: evidence)
        #expect(session.phase == .bootstrapping)
        try session.acceptBootstrapReceipt(.started(issued), observation: evidence)
        #expect(session.phase == .ready)
        try session.requireCurrentReady(issued, observation: evidence)
        try session.acceptCallback(.ready(issued), observation: evidence)
        #expect(session.phase == .ready)
    }

    @Test func launchReceiptAloneIsNotReadyAndWrongKindCannotAuthorize() throws {
        let source = try source()
        var session = Session(source: source, generationID: UUID())
        let navigation = UUID()
        let evidence = observation(source, navigation)
        try session.beginNavigation(navigation)
        try session.didCommit(evidence)
        let issued = try session.didFinish(evidence)
        #expect(throws: Session.SessionError.invalidPhase) {
            try session.acceptBootstrapReceipt(.locale(issued, .en), observation: evidence)
        }
        try session.acceptBootstrapReceipt(.started(issued), observation: evidence)
        #expect(session.phase == .bootstrapping)
        try session.acceptCallback(.ready(issued), observation: evidence)
        #expect(session.phase == .ready)
    }

    @Test func outgoingNavigationAndGraphCannotAuthorizeReplacement() throws {
        let source = try source()
        let generation = UUID()
        var session = Session(source: source, generationID: generation)
        let oldNavigation = UUID()
        let oldEvidence = observation(source, oldNavigation)
        try session.beginNavigation(oldNavigation)
        try session.didCommit(oldEvidence)
        let old = try session.didFinish(oldEvidence)
        let newNavigation = UUID()
        let newEvidence = observation(source, newNavigation)
        try session.beginNavigation(newNavigation)
        #expect(throws: Session.SessionError.staleNavigation) {
            try session.acceptCallback(.ready(old), observation: oldEvidence)
        }
        try session.didCommit(newEvidence)
        let fresh = try session.didFinish(newEvidence)
        #expect(old.documentID != fresh.documentID)
        #expect(throws: Session.SessionError.staleDocument) {
            try session.acceptCallback(.ready(old), observation: newEvidence)
        }
        let foreignGraph = Session.Provenance(documentID: fresh.documentID, generationID: UUID())
        #expect(throws: Session.SessionError.staleDocument) {
            try session.acceptBootstrapReceipt(.started(foreignGraph), observation: newEvidence)
        }
        try session.acceptBootstrapReceipt(.started(fresh), observation: newEvidence)
        try session.acceptCallback(.ready(fresh), observation: newEvidence)
        #expect(session.phase == .ready)
    }

    @Test func actualFrameOriginStoreAndDocumentAreCheckedForEveryReceipt() throws {
        let source = try source()
        var session = Session(source: source, generationID: UUID())
        let navigation = UUID()
        let evidence = observation(source, navigation)
        try session.beginNavigation(navigation)
        try session.didCommit(evidence)
        let issued = try session.didFinish(evidence)
        let foreign: [Session.Observation] = [
            observation(source, navigation, url: source.backendOrigin),
            observation(source, navigation, store: "foreign"),
            observation(source, navigation, main: false),
            observation(source, navigation, origin: URL(string: "http://127.0.0.1:49124")!),
            observation(source, navigation, origin: URL(string: "http://user@127.0.0.1:49123")!),
        ]
        for receipt in foreign {
            #expect(throws: Session.SessionError.foreignSource) {
                try session.acceptCallback(.ready(issued), observation: receipt)
            }
            #expect(throws: Session.SessionError.foreignSource) {
                try session.acceptBootstrapReceipt(.started(issued), observation: receipt)
            }
        }
        #expect(session.phase == .bootstrapping)
    }

    @Test func failureAndRetirementRejectLateActualCompletion() throws {
        for explicitCallback in [true, false] {
            let source = try source()
            var session = Session(source: source, generationID: UUID())
            let navigation = UUID()
            let evidence = observation(source, navigation)
            try session.beginNavigation(navigation)
            try session.didCommit(evidence)
            let issued = try session.didFinish(evidence)
            if explicitCallback {
                try session.acceptCallback(.failed(issued), observation: evidence)
            } else {
                session.fail()
            }
            #expect(session.phase == .failed)
            #expect(throws: Session.SessionError.invalidPhase) {
                try session.acceptBootstrapReceipt(.started(issued), observation: evidence)
            }
            #expect(throws: Session.SessionError.invalidPhase) {
                try session.acceptCallback(.ready(issued), observation: evidence)
            }
            session.retire()
            session.fail()
            #expect(session.phase == .retired)
            #expect(throws: Session.SessionError.invalidPhase) { try session.beginNavigation(UUID()) }
        }
    }
}
