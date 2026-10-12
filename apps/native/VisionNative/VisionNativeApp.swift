import SwiftUI

@main
struct VisionNativeApp: App {
    var body: some Scene {
        WindowGroup("Vision Native") {
            ShellRootView()
        }
        .defaultSize(width: 1440, height: 900)
    }
}
