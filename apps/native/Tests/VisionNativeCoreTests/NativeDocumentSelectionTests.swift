import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeDocumentSelectionTests {
    private let backend = URL(string: "http://127.0.0.1:49123")!
    private let key = NativeDocumentSelection.nativeOnlyEnvironmentKey

    private func select(
        environment: [String: String] = [:], debug: Bool = true, variant: String? = "demo",
        source: NativeShellBackendSource = .supervised(runtimeIdentifier: "vision_native_demo"),
        url: URL? = nil, store: String = "default"
    ) -> NativeDocumentSelection {
        .select(
            environment: environment, isDebugBuild: debug, rawVariant: variant, backendSource: source,
            backendURL: url ?? backend, websiteDataStoreIdentifier: store)
    }

    @Test func anEligibleLaunchDefaultsToNativeOnlyAtTheSupervisedOrigin() throws {
        guard case .nativeOnly(let source) = select() else {
            Issue.record("An eligible Debug Demo launch must default to the native-only mode")
            return
        }
        #expect(source.backendOrigin.absoluteString == "http://127.0.0.1:49123")
        #expect(source.websiteDataStoreIdentifier == "default")
        #expect(select().presentationMode == .nativeOnly)
        #expect(select(url: URL(string: "http://127.0.0.1:80/")!) != .retainedWeb)
    }

    @Test func onlyAnExactZeroOptsOutToTheRetainedWeb() {
        #expect(select(environment: [key: "0"]) == .retainedWeb)
        #expect(select(environment: [key: "0"]).presentationMode == .retainedWeb)
        for value in ["", "1", " 0", "false", "no"] {
            #expect(select(environment: [key: value]).presentationMode == .nativeOnly)
        }
        // The retired helper switch no longer selects anything.
        #expect(select(environment: ["VISION_NATIVE_HELPER_DOCUMENT": "1"]).presentationMode == .nativeOnly)
    }

    @Test func aDeveloperOverrideNeverVouchesForTheDemoRuntime() {
        #expect(select(source: .developerOverride) == .retainedWeb)
        #expect(select(source: .supervised(runtimeIdentifier: "vision_native")) == .retainedWeb)
        #expect(select(environment: [key: "1"], source: .developerOverride) == .retainedWeb)
    }

    @Test func releaseAndStandardBuildsKeepTheRetainedWeb() {
        #expect(select(debug: false) == .retainedWeb)
        #expect(select(variant: "standard") == .retainedWeb)
        #expect(select(variant: nil) == .retainedWeb)
        #expect(select(environment: [key: "1"], debug: false) == .retainedWeb)
    }

    @Test func nonLoopbackOrMalformedBackendsKeepTheRetainedWeb() {
        for raw in ["http://192.168.1.5:49123", "file:///tmp", "http://127.0.0.1:49123/app", "http://u@127.0.0.1:1"] {
            #expect(select(url: URL(string: raw)!) == .retainedWeb)
        }
        #expect(select(store: " ") == .retainedWeb)
    }
}
