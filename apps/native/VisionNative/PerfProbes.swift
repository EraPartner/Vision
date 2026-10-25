import AppKit
import Darwin
import VisionNativeCore

/// Process measurements for the perf run: start time, CPU time and physical footprint.
enum PerfProbes {
    /// The process start time in epoch milliseconds (`kinfo_proc.p_starttime`), so the launch
    /// is measured from exec, not from the first line of Swift.
    static func processStartEpochMs() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let status = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard status == 0 else { return Date().timeIntervalSince1970 * 1000 }
        let started = info.kp_proc.p_un.__p_starttime
        return Double(started.tv_sec) * 1000 + Double(started.tv_usec) / 1000
    }

    /// User and system CPU seconds of this process so far (all threads).
    static func cpuSeconds() -> (user: Double, system: Double) {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return (0, 0) }
        func seconds(_ value: timeval) -> Double { Double(value.tv_sec) + Double(value.tv_usec) / 1_000_000 }
        return (seconds(usage.ru_utime), seconds(usage.ru_stime))
    }

    /// `phys_footprint` (task_vm_info): what Activity Monitor calls Memory, in MB.
    static func footprintMb() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                task_info(mach_task_self(), task_flavor_t(TASK_VM_INFO), raw, &count)
            }
        }
        guard status == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576
    }

    static func snapshot() -> PerfProcessSnapshot {
        let cpu = cpuSeconds()
        return PerfProcessSnapshot(cpuSeconds: cpu.user + cpu.system, footprintMb: footprintMb())
    }
}

/// The vertical scroll view the harness scrolls: SwiftUI's `ScrollView` is an `NSScrollView`, so
/// the page's ledger is the visible one with the largest area that has room to scroll.
@MainActor
struct PerfScroller {
    let scrollView: NSScrollView

    /// Content points between the top and the bottom stop.
    var maxOffset: Double {
        guard let document = scrollView.documentView else { return 0 }
        let insets = scrollView.contentInsets
        let visible = scrollView.contentView.bounds.height
        return Double(document.frame.height - visible + insets.top + insets.bottom)
    }

    /// Scrolls to `offset` points below the top stop.
    func setOffset(_ offset: Double) {
        guard let document = scrollView.documentView else { return }
        let clip = scrollView.contentView
        let insets = scrollView.contentInsets
        let travel = CGFloat(offset)
        let y: CGFloat
        if document.isFlipped {
            y = -insets.top + travel
        } else {
            y = document.frame.height - clip.bounds.height + insets.top - travel
        }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scrollView.reflectScrolledClipView(clip)
    }

    static func largest(in root: NSView) -> PerfScroller? {
        var best: (scroller: PerfScroller, area: Double)?
        var pending: [NSView] = [root]
        while let view = pending.popLast() {
            pending.append(contentsOf: view.subviews)
            guard let scrollView = view as? NSScrollView, !scrollView.isHiddenOrHasHiddenAncestor else { continue }
            let candidate = PerfScroller(scrollView: scrollView)
            guard candidate.maxOffset > PerfScrollPlan.minimumTravel else { continue }
            let size = scrollView.contentView.bounds.size
            let area = Double(size.width * size.height)
            if area > (best?.area ?? 0) { best = (candidate, area) }
        }
        return best?.scroller
    }
}
