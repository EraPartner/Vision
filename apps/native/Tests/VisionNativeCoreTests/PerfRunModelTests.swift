import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Perf run model")
struct PerfRunModelTests {
    private func settings(_ values: [String: String]) -> PerfRunSettings? {
        PerfRunSettings(reading: { values[$0] })
    }

    @Test("no directory key means no run")
    func offByDefault() {
        #expect(settings([:]) == nil)
        #expect(settings([PerfRunSettings.directoryKey: ""]) == nil)
        #expect(settings([PerfRunSettings.directoryKey: "relative/dir"]) == nil)
    }

    @Test("the defaults are 30 s idle and 60 s sustained")
    func defaults() {
        let run = settings([PerfRunSettings.directoryKey: "/tmp/perf"])
        #expect(run?.directory == "/tmp/perf")
        #expect(run?.idleSeconds == 30)
        #expect(run?.sustainedSeconds == 60)
    }

    @Test("durations can be overridden and bad values fall back")
    func overrides() {
        let run = settings([
            PerfRunSettings.directoryKey: "/tmp/perf", PerfRunSettings.idleSecondsKey: "5",
            PerfRunSettings.sustainedSecondsKey: "-3",
        ])
        #expect(run?.idleSeconds == 5)
        #expect(run?.sustainedSeconds == 60)
    }

    @Test("the scroll plan goes down and back at a steady speed")
    func scrollPlan() throws {
        let plan = try #require(PerfScrollPlan(maxOffset: 100_000, legLimit: PerfScrollPlan.ledgerLeg))
        #expect(plan.distance == 7500)
        #expect(plan.duration == 10)
        #expect(plan.offset(at: 2) == 3000)
        #expect(plan.offset(at: 5) == 7500)
        #expect(plan.offset(at: 8) == 3000)
        #expect(plan.offset(at: 10) == 0)
        #expect(!plan.isFinished(at: 9.9))
        #expect(plan.isFinished(at: 10))
    }

    @Test("a short scroller shortens the leg and a tiny one is skipped")
    func scrollPlanLimits() throws {
        let short = try #require(PerfScrollPlan(maxOffset: 3000, legLimit: PerfScrollPlan.ledgerLeg))
        #expect(short.distance == 3000)
        #expect(PerfScrollPlan(maxOffset: 10, legLimit: PerfScrollPlan.ledgerLeg) == nil)
    }

    @Test("hitches are intervals above 1.5 refresh intervals")
    func frameStats() throws {
        // Nine 8 ms frames, then one 20 ms gap and one 40 ms gap.
        var stamps: [Double] = [0]
        for _ in 0..<9 { stamps.append((stamps.last ?? 0) + 8) }
        stamps.append((stamps.last ?? 0) + 20)
        stamps.append((stamps.last ?? 0) + 40)
        let stats = try #require(PerfFrameAnalysis.stats(stampsMs: stamps))
        #expect(stats.frames == 12)
        #expect(stats.refreshMs == 8)
        #expect(stats.hitches == 2)
        #expect(stats.maxIntervalMs == 40)
        #expect(PerfFrameAnalysis.stats(stampsMs: [1]) == nil)
    }

    @Test("the script visits the harness pages and a sustained cycle skips the ledger")
    func script() {
        let pages = PerfRunScript.pages.map(\.rawValue)
        #expect(pages == ["/", "/transactions", "/accounts", "/statistics", "/planned", "/portfolio"])
        #expect(PerfRunScript.sustainedPages().map(\.rawValue) == ["/", "/accounts", "/statistics"])
    }

    @Test("results round-trip through JSON with the documented keys")
    func resultsJSON() throws {
        let phase = PerfPhaseResult(
            name: .scroll, startEpochMs: 1000, endEpochMs: 2000, wallMs: 1000, cpuSeconds: 0.5,
            cpuUserSeconds: 0.4, cpuSystemSeconds: 0.1, footprintStartMb: 300, footprintEndMb: 310,
            framesTracked: true, frameStampsMs: [0, 8, 16], steps: [], scroll: nil, cycles: nil,
            windowVisibleAtEnd: true, appActiveAtEnd: true)
        let results = PerfRunResults(
            app: PerfAppInfo(
                name: "Vision Native Demo", bundleIdentifier: "com.vaultvoyager.vision-native-demo",
                variant: "demo", version: "1.0.0", pid: 42),
            machine: nil, options: PerfOptionsInfo(idleSeconds: 30, sustainedSeconds: 60),
            processStartEpochMs: 500, readyEpochMs: 900, afterLaunch: nil, phases: [phase], error: nil)
        #expect(results.launchToReadyMs == 400)
        let data = try results.jsonData()
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"launchToReadyMs\""))
        #expect(text.contains("\"frameStampsMs\""))
        let decoded = try JSONDecoder().decode(PerfRunResults.self, from: data)
        #expect(decoded == results)
        #expect(decoded.phases.first?.frames?.hitches == 0)
    }
}
