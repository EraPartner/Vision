import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeHelperDocumentSelectionTests {
    private let backend = URL(string: "http://127.0.0.1:49123")!

    private func select(
        environment: [String: String] = [NativeHelperDocumentSelection.environmentKey: "1"],
        debug: Bool = true, variant: String? = "demo",
        source: NativeShellBackendSource = .supervised(runtimeIdentifier: "vision_native_demo"),
        url: URL? = nil, store: String = "default"
    ) -> NativeHelperDocumentSelection {
        .select(
            environment: environment, isDebugBuild: debug, rawVariant: variant, backendSource: source,
            backendURL: url ?? backend, websiteDataStoreIdentifier: store)
    }

    @Test func eligibleOptInSelectsTheHelperAtTheSupervisedOrigin() throws {
        guard case .helperDocument(let source) = select() else {
            Issue.record("An eligible opt-in must select the helper document")
            return
        }
        #expect(source.helperURL.absoluteString == "http://127.0.0.1:49123/native-helper.html")
        #expect(source.websiteDataStoreIdentifier == "default")
        #expect(select().presentationMode == .helperDocument)
    }

    @Test func withoutTheExactHelperOptInTheNativeOnlyDefaultApplies() {
        for value in [nil, "", "0", "true", "yes", " 1"] as [String?] {
            let environment = value.map { [NativeHelperDocumentSelection.environmentKey: $0] } ?? [:]
            #expect(select(environment: environment).presentationMode == .nativeOnly)
        }
    }

    @Test func anExactWebFreeZeroOptsOutToTheHelperOrTheRetainedWeb() {
        let key = NativeHelperDocumentSelection.nativeOnlyEnvironmentKey
        #expect(select(environment: [key: "0"]) == .retainedWeb)
        let helper = [key: "0", NativeHelperDocumentSelection.environmentKey: "1"]
        #expect(select(environment: helper).presentationMode == .helperDocument)
        #expect(select(environment: [key: " 0"]).presentationMode == .nativeOnly)
    }

    @Test func theWebFreeOptInSelectsNativeOnlyUnderTheSameEligibility() {
        let key = NativeHelperDocumentSelection.nativeOnlyEnvironmentKey
        guard case .nativeOnly(let source) = select(environment: [key: "1"]) else {
            Issue.record("An eligible web-free opt-in must select the native-only mode")
            return
        }
        #expect(source.backendOrigin.absoluteString.hasPrefix("http://127.0.0.1:49123"))
        #expect(select(environment: [key: "1"]).presentationMode == .nativeOnly)
        let both = [key: "1", NativeHelperDocumentSelection.environmentKey: "1"]
        #expect(select(environment: both).presentationMode == .nativeOnly)
        for value in ["", "true", " 1"] {
            let helper = [key: value, NativeHelperDocumentSelection.environmentKey: "1"]
            #expect(select(environment: helper).presentationMode == .helperDocument)
        }
        #expect(select(environment: [key: "1"], debug: false) == .retainedWeb)
        #expect(select(environment: [key: "1"], variant: "standard") == .retainedWeb)
        #expect(select(environment: [key: "1"], source: .developerOverride) == .retainedWeb)
    }

    @Test func aDeveloperOverrideNeverVouchesForTheDemoRuntime() {
        #expect(select(source: .developerOverride) == .retainedWeb)
        #expect(select(source: .supervised(runtimeIdentifier: "vision_native")) == .retainedWeb)
        #expect(select(environment: [:], source: .developerOverride) == .retainedWeb)
    }

    @Test func releaseAndStandardBuildsCannotOptIn() {
        #expect(select(debug: false) == .retainedWeb)
        #expect(select(variant: "standard") == .retainedWeb)
        #expect(select(variant: nil) == .retainedWeb)
        #expect(select(debug: false).presentationMode == .retainedWeb)
        #expect(select(environment: [:], debug: false) == .retainedWeb)
        #expect(select(environment: [:], variant: "standard") == .retainedWeb)
    }

    @Test func nonLoopbackOrMalformedBackendsKeepTheRetainedWeb() {
        for raw in ["http://192.168.1.5:49123", "file:///tmp", "http://127.0.0.1:49123/app", "http://u@127.0.0.1:1"] {
            #expect(select(url: URL(string: raw)!) == .retainedWeb)
        }
        #expect(select(store: " ") == .retainedWeb)
    }
}
