import os

/// Instruments intervals contain static operation names only, never financial values or queries.
/// End a started interval with `defer`, including failed or cancelled work. These measure CPU/data
/// preparation boundaries; they do not claim that the window server has presented a frame.
public enum NativePerformance {
    private static let signposter = OSSignposter(subsystem: "com.vaultvoyager.vision-native", category: "Performance")

    public static func begin(_ name: StaticString) -> OSSignpostIntervalState {
        signposter.beginInterval(name, id: signposter.makeSignpostID())
    }

    public static func end(_ name: StaticString, _ interval: OSSignpostIntervalState) {
        signposter.endInterval(name, interval)
    }

    public static func event(_ name: StaticString) {
        signposter.emitEvent(name)
    }
}
