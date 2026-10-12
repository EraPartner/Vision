// swift-tools-version: 6.0
import PackageDescription

// Non-UI logic for Vision Native (ADR-204). The app target in project.yml links
// VisionNativeCore; `swift test --package-path apps/native` runs the tests.
let package = Package(
    name: "VisionNativeCore",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "VisionNativeCore", targets: ["VisionNativeCore"])
    ],
    targets: [
        .target(name: "VisionNativeCore"),
        .testTarget(
            name: "VisionNativeCoreTests",
            dependencies: ["VisionNativeCore"],
            // The Vision 1.0.2 backup fixture (packaging/electron/backup/fixtures), byte for byte.
            resources: [.copy("Fixtures/vision-1.0.2-sanitized.visionbak.enc")]
        ),
    ]
)
