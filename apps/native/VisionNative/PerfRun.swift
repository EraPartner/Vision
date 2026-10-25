import AppKit
import QuartzCore
import VisionNativeCore

/// The in-app perf run: the Swift counterpart of scripts/mac-baseline.ts, started by the
/// `VisionPerfRun` default (an output directory) and otherwise absent. `startIfRequested` is one
/// `UserDefaults` read when it is off. The JSON it writes is documented in `PerfRunModel.swift`;
/// `scripts/mac-baseline.ts --native` launches the app with it and reads the file.
///
///     open -a "Vision Native Demo" --args -VisionPerfRun /tmp/vision-perf
///     defaults write com.vaultvoyager.vision-native-demo VisionPerfRun /tmp/vision-perf
///
/// The default is deleted when the run starts, so a crashed run never repeats on the next
/// launch, and the app quits when the run ends.
@MainActor
final class PerfRun {
    private static var active: PerfRun?

    static func startIfRequested(shell: ShellController) {
        let defaults = UserDefaults.standard
        guard let settings = PerfRunSettings(reading: { defaults.string(forKey: $0) }) else { return }
        defaults.removeObject(forKey: PerfRunSettings.directoryKey)
        let run = PerfRun(shell: shell, settings: settings)
        active = run
        Task { await run.run() }
    }

    private struct Failure: Error {
        let message: String
    }

    private struct PhaseDetail {
        var steps: [PerfStep] = []
        var scroll: PerfScrollDetail?
        var cycles: Int?
    }

    private let shell: ShellController
    private let settings: PerfRunSettings
    private let clock = PerfFrameClock()
    private let processStartEpochMs = PerfProbes.processStartEpochMs()
    private var machine: PerfMachineInfo?
    private var readyEpochMs: Double?
    private var afterLaunch: PerfProcessSnapshot?
    private var phases: [PerfPhaseResult] = []

    private init(shell: ShellController, settings: PerfRunSettings) {
        self.shell = shell
        self.settings = settings
    }

    private func run() async {
        var failure: String?
        do {
            try await execute()
        } catch let error as Failure {
            failure = error.message
        } catch {
            failure = String(describing: error)
        }
        clock.stop()
        write(error: failure)
        NSApp.terminate(nil)
    }

    private func execute() async throws {
        try await waitUntilReady()
        readyEpochMs = Self.nowMs()
        guard let window = shell.window, let content = window.contentView else {
            throw Failure(message: "The window is missing.")
        }
        // A terminal launch leaves the app behind other windows; hidden windows get no frames.
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        machine = Self.machineInfo(window: window, content: content)
        clock.attach(to: content)

        // The harness settles 10 s after launch, then idles on Home.
        try await Task.sleep(for: .seconds(PerfRunScript.settleSeconds))
        afterLaunch = PerfProbes.snapshot()
        _ = try await navigate(to: .home)
        try await Task.sleep(for: .seconds(3))

        try await measure(.idle, tracksFrames: false) {
            try await Task.sleep(for: .seconds(self.settings.idleSeconds))
            return PhaseDetail()
        }

        _ = try await navigate(to: .transactions)
        try await Task.sleep(for: .milliseconds(1500))
        try await measure(.scroll, tracksFrames: true) {
            var detail = PhaseDetail()
            detail.scroll = try await self.scrollLedger(legLimit: PerfScrollPlan.ledgerLeg)
            return detail
        }

        if let last = PerfRunScript.pages.last { _ = try await navigate(to: last) }
        try await measure(.pageSwitch, tracksFrames: true) {
            var detail = PhaseDetail()
            for _ in 0..<PerfRunScript.pageSwitchPasses {
                for page in PerfRunScript.pages {
                    detail.steps.append(try await self.navigate(to: page))
                }
            }
            return detail
        }

        if settings.sustainedSeconds > 0 {
            try await measure(.sustained, tracksFrames: true) { try await self.sustainedLoop() }
        }
    }

    // MARK: Phases

    private func measure(
        _ name: PerfPhaseName, tracksFrames: Bool, body: () async throws -> PhaseDetail
    ) async throws {
        let startCpu = PerfProbes.cpuSeconds()
        let startFootprint = PerfProbes.footprintMb()
        let startEpoch = Self.nowMs()
        let startMonotonic = CACurrentMediaTime() * 1000
        if tracksFrames { clock.beginRecording() }
        let detail: PhaseDetail
        do {
            detail = try await body()
        } catch {
            _ = clock.endRecording()
            throw error
        }
        let stamps = tracksFrames ? clock.endRecording() : []
        let endEpoch = Self.nowMs()
        let endCpu = PerfProbes.cpuSeconds()
        let user = endCpu.user - startCpu.user
        let system = endCpu.system - startCpu.system
        let window = shell.window
        phases.append(
            PerfPhaseResult(
                name: name, startEpochMs: startEpoch, endEpochMs: endEpoch, wallMs: endEpoch - startEpoch,
                cpuSeconds: user + system, cpuUserSeconds: user, cpuSystemSeconds: system,
                footprintStartMb: startFootprint, footprintEndMb: PerfProbes.footprintMb(),
                framesTracked: tracksFrames, frameStampsMs: stamps.map { $0 - startMonotonic },
                steps: detail.steps, scroll: detail.scroll, cycles: detail.cycles,
                windowVisibleAtEnd: window?.occlusionState.contains(.visible) ?? false,
                appActiveAtEnd: NSApp.isActive))
    }

    private func sustainedLoop() async throws -> PhaseDetail {
        var detail = PhaseDetail()
        var cycles = 0
        let deadline = Date().addingTimeInterval(settings.sustainedSeconds)
        while Date() < deadline {
            detail.steps.append(try await navigate(to: .transactions))
            let scroll = try await scrollLedger(legLimit: PerfScrollPlan.sustainedLeg)
            if !scroll.found { try await Task.sleep(for: .seconds(2)) }
            for page in PerfRunScript.sustainedPages() {
                if Date() >= deadline { break }
                detail.steps.append(try await navigate(to: page))
            }
            cycles += 1
        }
        detail.cycles = cycles
        return detail
    }

    // MARK: Driving the shell

    private func waitUntilReady() async throws {
        let deadline = Date().addingTimeInterval(180)
        while !shell.perfShellIsReady {
            if Date() > deadline { throw Failure(message: "The shell was not ready within 180 s.") }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    /// A Go-menu navigation, then the harness's dwell. `settleMs` is the time until the route changed.
    private func navigate(to destination: NativeRoute.Destination) async throws -> PerfStep {
        let path = destination.rawValue
        let started = Date()
        var timedOut = false
        if shell.perfRoutePath != path {
            shell.perfNavigate(to: path)
            while shell.perfRoutePath != path || !shell.perfShellIsReady {
                if Date().timeIntervalSince(started) > 15 {
                    timedOut = true
                    break
                }
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        let settleMs = Date().timeIntervalSince(started) * 1000
        try await Task.sleep(for: .seconds(PerfRunScript.dwellSeconds))
        return PerfStep(path: path, settleMs: settleMs, timedOut: timedOut)
    }

    /// Scrolls the page's largest scroll view down and back up at a steady speed, one step per
    /// display frame, like a held trackpad gesture.
    private func scrollLedger(legLimit: Double) async throws -> PerfScrollDetail {
        guard let root = shell.window?.contentView, let scroller = PerfScroller.largest(in: root),
            let plan = PerfScrollPlan(maxOffset: scroller.maxOffset, legLimit: legLimit)
        else { return PerfScrollDetail(found: false, distancePx: 0, durationMs: 0) }
        scroller.setOffset(0)
        var origin: Double?
        while true {
            guard let now = await clock.nextFrame() else {
                throw Failure(message: "No display frames arrived while scrolling (window hidden?).")
            }
            let start = origin ?? now
            origin = start
            let elapsed = now - start
            scroller.setOffset(plan.offset(at: elapsed))
            if plan.isFinished(at: elapsed) { break }
        }
        scroller.setOffset(0)
        return PerfScrollDetail(found: true, distancePx: plan.distance, durationMs: plan.duration * 1000)
    }

    // MARK: Output

    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private static func machineInfo(window: NSWindow, content: NSView) -> PerfMachineInfo {
        let scale = Double(window.backingScaleFactor)
        let info = ProcessInfo.processInfo
        return PerfMachineInfo(
            maximumFramesPerSecond: window.screen?.maximumFramesPerSecond ?? 0, backingScale: scale,
            windowPixelsWide: Double(content.bounds.width) * scale,
            windowPixelsHigh: Double(content.bounds.height) * scale,
            lowPowerMode: info.isLowPowerModeEnabled, thermalState: info.thermalState.rawValue)
    }

    private func write(error: String?) {
        let bundle = Bundle.main
        let results = PerfRunResults(
            app: PerfAppInfo(
                name: bundle.infoDictionary?["CFBundleName"] as? String ?? "Vision Native",
                bundleIdentifier: bundle.bundleIdentifier ?? "", variant: AppRuntime.variant.rawValue,
                version: bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
                pid: Int(ProcessInfo.processInfo.processIdentifier)),
            machine: machine,
            options: PerfOptionsInfo(idleSeconds: settings.idleSeconds, sustainedSeconds: settings.sustainedSeconds),
            processStartEpochMs: processStartEpochMs, readyEpochMs: readyEpochMs, afterLaunch: afterLaunch,
            phases: phases, error: error)
        do {
            let directory = URL(fileURLWithPath: settings.directory, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent(PerfRunResults.fileName)
            try results.jsonData().write(to: file, options: .atomic)
            AppRuntime.logger.log("[perf] wrote \(file.path, privacy: .public)")
        } catch {
            AppRuntime.logger.error("[perf] could not write results: \(String(describing: error), privacy: .public)")
        }
    }
}

/// Display-frame timestamps from a `CADisplayLink` on the window's content view. The link runs
/// only while recording, so the idle phase pays nothing for it.
@MainActor
final class PerfFrameClock: NSObject {
    private var link: CADisplayLink?
    private var stamps: [Double] = []
    private var recording = false
    private var waiter: CheckedContinuation<Double?, Never>?
    private var lastTickAt = Date()
    private var watchdog: Task<Void, Never>?

    func attach(to view: NSView) {
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.isPaused = true
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func beginRecording() {
        stamps.removeAll(keepingCapacity: true)
        stamps.reserveCapacity(20_000)
        recording = true
        lastTickAt = Date()
        link?.isPaused = false
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.expireWaiterIfStalled()
            }
        }
    }

    /// The timestamps in milliseconds on the `CACurrentMediaTime` clock.
    func endRecording() -> [Double] {
        recording = false
        link?.isPaused = true
        watchdog?.cancel()
        watchdog = nil
        resumeWaiter(with: nil)
        return stamps
    }

    func stop() {
        link?.invalidate()
        link = nil
        watchdog?.cancel()
        resumeWaiter(with: nil)
    }

    /// The next frame's timestamp in seconds, or `nil` when no frame arrived for 3 s.
    func nextFrame() async -> Double? {
        guard recording else { return nil }
        return await withCheckedContinuation { waiter = $0 }
    }

    @objc private func tick(_ link: CADisplayLink) {
        lastTickAt = Date()
        if recording { stamps.append(link.timestamp * 1000) }
        resumeWaiter(with: link.timestamp)
    }

    private func resumeWaiter(with value: Double?) {
        guard let pending = waiter else { return }
        waiter = nil
        pending.resume(returning: value)
    }

    private func expireWaiterIfStalled() {
        if waiter != nil, Date().timeIntervalSince(lastTickAt) > 3 { resumeWaiter(with: nil) }
    }
}
