import Darwin
import Foundation
import Synchronization

/// Hands freed heap pages back to the system. A burst of decoded API answers, chart series and
/// table rows is released by ARC long before macOS counts it out of the process footprint: the
/// malloc zones keep the pages dirty until asked. The footprint (Activity Monitor's Memory)
/// therefore climbs with every screen visit even though the models free their rows.
///
/// A request runs once the app has been quiet for `settle`; a newer request restarts the wait.
/// Unless forced, it only relieves when the footprint grew by `growthThreshold` since the last relief, so an idle
/// app that polls a little costs one cheap footprint read per request and nothing more.
public final class MemoryRelief: Sendable {
    public static let shared = MemoryRelief()
    /// How long a request waits for further allocations to stop before it relieves.
    public static let settle: Duration = .seconds(4)
    /// Footprint growth, in bytes, that makes an unforced request worth running.
    public static let growthThreshold: UInt64 = 24 * 1_048_576

    private struct State {
        var pending: Task<Void, Never>?
        var generation = 0
        var baseline: UInt64 = 0
        var forced = false
    }

    private let box = Mutex(State())
    private let footprint: @Sendable () -> UInt64
    private let relieve: @Sendable () -> Void
    private let pause: @Sendable (Duration) async -> Void

    public init(
        footprint: @escaping @Sendable () -> UInt64 = MemoryRelief.systemFootprint,
        relieve: @escaping @Sendable () -> Void = MemoryRelief.systemRelieve,
        pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) {
        self.footprint = footprint
        self.relieve = relieve
        self.pause = pause
    }

    /// Asks for a relief once things settle. `force` skips the growth check (memory was just
    /// dropped on purpose, so the pages are known to be free).
    public func request(force: Bool = false) {
        box.withLock { current in
            if force { current.forced = true }
            current.pending?.cancel()
            current.generation += 1
            let generation = current.generation
            current.pending = Task.detached(priority: .utility) { [self] in
                await pause(Self.settle)
                guard !Task.isCancelled else { return }
                run(generation: generation)
            }
        }
    }

    /// Waits for the pending relief, if any. For tests.
    public func settled() async {
        let task = box.withLock { $0.pending }
        await task?.value
    }

    private func run(generation: Int) {
        let request = box.withLock { current -> Bool? in
            guard current.generation == generation else { return nil }
            let value = current.forced
            current.forced = false
            return value
        }
        guard let forced = request else { return }
        let now = footprint()
        let baseline = box.withLock { $0.baseline }
        if forced || now > baseline &+ Self.growthThreshold {
            relieve()
            let after = footprint()
            box.withLock { $0.baseline = after }
        }
        box.withLock { current in
            if current.generation == generation { current.pending = nil }
        }
    }

    /// `ri_phys_footprint` (`proc_pid_rusage`): what Activity Monitor calls Memory.
    public static let systemFootprint: @Sendable () -> UInt64 = {
        var info = rusage_info_v4()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { raw in
                proc_pid_rusage(getpid(), RUSAGE_INFO_V4, raw)
            }
        }
        return status == 0 ? info.ri_phys_footprint : 0
    }

    /// `malloc_zone_pressure_relief(NULL, 0)`: every zone returns what it can.
    public static let systemRelieve: @Sendable () -> Void = {
        _ = malloc_zone_pressure_relief(nil, 0)
    }
}
