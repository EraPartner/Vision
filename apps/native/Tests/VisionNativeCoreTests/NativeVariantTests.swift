import Foundation
import Testing
@testable import VisionNativeCore

// The Demo variant (phase 1e): its own identity, port, directory and Keychain service.

@Suite struct NativeVariantTests {
    @Test func eachVariantHasItsOwnIdentity() {
        #expect(NativeVariant.standard.appName == "Vision Native")
        #expect(NativeVariant.standard.runtimeId == "vision_native")
        #expect(NativeVariant.standard.postgresPort == 54331)
        #expect(NativeVariant.standard.backupPassphraseService == KeychainPassphraseStore.standardService)
        #expect(NativeVariant.demo.appName == "Vision Native Demo")
        #expect(NativeVariant.demo.runtimeId == "vision_native_demo")
        #expect(NativeVariant.demo.postgresPort == 54332)
        #expect(NativeVariant.demo.backupPassphraseService == "com.vaultvoyager.vision-native-demo.backup-passphrase")
        #expect(
            NativeVariant.demo.userDataDirectory(homeDirectory: testHome)
                == "\(testHome)/Library/Application Support/Vision Native Demo")
        // Never an Electron port, runtime id or directory.
        for variant in NativeVariant.allCases {
            #expect(![54329, 54330].contains(variant.postgresPort))
            #expect(!["vision", "vision_demo"].contains(variant.runtimeId))
            #expect(!VisionNativeIdentity.foreignUserDataNames.contains(variant.userDataName))
        }
    }

    @Test func theStandardVariantSharesElectronsBackupFolderButNotItsDeviceId() {
        #expect(NativeVariant.standard.backupFolderName == "Vision")
        #expect(NativeVariant.demo.backupFolderName == "Vision Native Demo")
        // Retention only prunes `vision_backup_<deviceId>_*`, and the id hashes the data directory.
        let native = BackupDevice.deviceId(
            platform: "darwin", architecture: "arm64", hostname: "mac",
            userData: NativeVariant.standard.userDataDirectory(homeDirectory: testHome))
        let electron = BackupDevice.deviceId(
            platform: "darwin", architecture: "arm64", hostname: "mac",
            userData: "\(testHome)/Library/Application Support/Vision")
        #expect(native != electron)
    }

    @Test func theInfoPlistValuePicksTheVariant() {
        #expect(NativeVariant.fromInfoPlist("demo") == .demo)
        #expect(NativeVariant.fromInfoPlist("standard") == .standard)
        #expect(NativeVariant.fromInfoPlist(nil) == .standard)
        #expect(NativeVariant.fromInfoPlist("$(VISION_NATIVE_VARIANT)") == .standard)
        #expect(NativeVariant.fromInfoPlist(1) == .standard)
    }

    @Test func layoutsAndSeedingStayInsideTheVariant() throws {
        let demo = try RuntimeLayout(variant: .demo, homeDirectory: testHome)
        #expect(demo.runtimeId == "vision_native_demo")
        #expect(demo.nativeRoot == "\(testHome)/Library/Application Support/Vision Native Demo/native/vision_native_demo")
        try NativeDemo.assertIsolation(demo)
        try NativeDemo.assertIsolation(try RuntimeLayout(variant: .standard, homeDirectory: testHome))
        // A variant's directory with the other variant's runtime id is refused.
        let crossed = try RuntimeLayout(
            userDataDirectory: NativeVariant.demo.userDataDirectory(homeDirectory: testHome), runtimeId: "vision_native")
        let error = #expect(throws: NativeRuntimeError.self) { try NativeDemo.assertIsolation(crossed) }
        #expect(error?.code == "DEMO_RUNTIME_UNSAFE")
        #expect(throws: NativeRuntimeError.self) {
            try RuntimeLayout(userDataDirectory: "\(testHome)/Library/Application Support/Vision Native Demo2")
        }
    }

    @Test func theSupervisorConfigurationFollowsTheVariant() {
        let demo = SupervisorConfiguration(
            environment: [:], homeDirectory: testHome, resourcesDirectory: nil, variant: .demo)
        #expect(demo.postgresPort == 54332)
        let pinned = SupervisorConfiguration(
            environment: [:], homeDirectory: testHome, resourcesDirectory: nil, postgresPort: 60000, variant: .demo)
        #expect(pinned.postgresPort == 60000)
        #expect(SupervisorConfiguration(environment: [:], homeDirectory: testHome, resourcesDirectory: nil).postgresPort == 54331)
    }
}
