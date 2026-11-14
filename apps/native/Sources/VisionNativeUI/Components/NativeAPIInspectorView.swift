import SwiftUI
import VisionNativeCore

/// DevtoolsRoot in admin mode: the floating "API" pill (⌘⇧A) and the inspector panel above it.
/// Copy is English, as in the web inspector.
struct NativeAPIInspectorOverlay: View {
    let model: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if model.isOpen {
                NativeAPIInspectorPanel(model: model)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            toggle
        }
        .padding(16)
        .animation(.easeOut(duration: 0.2), value: model.isOpen)
    }

    /// InspectorToggle: `Button variant="outline" size="sm"` made a pill (`rounded-full font-mono
    /// type-footnote shadow-elevation-2`), secondary text that turns foreground on hover, a
    /// `primary/50` border and primary text while open, and the Activity glyph pulsing in the
    /// warning colour with the in-flight count while requests run.
    private var toggle: some View {
        Button {
            model.toggle()
        } label: {
            NativeAPIInspectorToggleLabel(isOpen: model.isOpen, inFlight: model.inFlight.count)
        }
        .buttonStyle(.plain)
        .keyboardShortcut("a", modifiers: [.command, .shift])
        .help("Toggle API Inspector (⌘⇧A)")
        .accessibilityLabel("Toggle API Inspector (⌘⇧A)")
        .accessibilityAddTraits(model.isOpen ? .isSelected : [])
    }
}

private struct NativeAPIInspectorToggleLabel: View {
    let isOpen: Bool
    let inFlight: Int
    @State private var hovering = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let pending = inFlight > 0
        let text = isOpen ? theme.primary : hovering ? theme.foreground : theme.secondaryLabel
        HStack(spacing: 6) {
            Image(systemName: "waveform.path.ecg").font(.system(size: 11, weight: .medium))
                .symbolEffect(.pulse, isActive: pending)
                .foregroundStyle(pending ? theme.warning : text)
                .accessibilityHidden(true)
            Text(verbatim: "API")
            if pending {
                Text(String(inFlight)).monospacedDigit().foregroundStyle(theme.warning)
            }
        }
        .font(.system(size: 12, design: .monospaced))
        .foregroundStyle(text)
        .padding(.horizontal, 12)
        .frame(height: VisionControlMetrics.heightSm)
        .background(
            Capsule().fill(Color(token: theme.palette.background, opacity: hovering ? 1 : 0.8))
                .visionElevation(DesignTokens.Elevation.level2))
        .overlay(
            Capsule().strokeBorder(
                isOpen ? theme.primary.opacity(0.5) : Color(token: theme.palette.input, opacity: 0.7),
                lineWidth: VisionControlMetrics.borderWidth))
        .contentShape(Capsule())
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: DesignTokens.Duration.fast), value: hovering)
    }
}

private struct NativeAPIInspectorPanel: View {
    @Bindable var model: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(theme.border).frame(height: 1)
            tabs
            switch model.tab {
            case .requests: requests
            case .metrics: NativeAPIMetricsView(model: model)
            case .queries: NativeAPIQueriesView(model: model)
            }
        }
        // `rounded-card border border-border bg-background shadow-elevation-4`, 520 × 480.
        .frame(width: 520, height: 480)
        .background(shape.fill(Color(token: theme.palette.background)))
        .clipShape(shape)
        .overlay(shape.strokeBorder(theme.border, lineWidth: 1))
        .background(shape.fill(Color(token: theme.palette.background)).visionElevation(DesignTokens.Elevation.level4))
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.card), style: .continuous)
    }

    /// The `TabsList`: `h-8 px-2 border-b border-border`, each trigger `h-7 px-3 type-footnote`
    /// with a 2 pt primary underline while active.
    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(NativeAPIInspectorModel.Tab.allCases, id: \.self) { tab in
                let active = model.tab == tab
                let title = tab.rawValue.prefix(1).uppercased() + tab.rawValue.dropFirst()
                Button {
                    model.tab = tab
                } label: {
                    Text(verbatim: title).font(.footnote)
                        .foregroundStyle(active ? theme.foreground : theme.secondaryLabel)
                        .padding(.horizontal, 12).frame(height: 28)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(active ? theme.primary : .clear).frame(height: 2)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(active ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).frame(height: 32)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(verbatim: "API Inspector").font(.headline).foregroundStyle(theme.foreground)
            if !model.inFlight.isEmpty {
                VisionBadge(text: "\(model.inFlight.count) in-flight", tone: .warning, small: true, monospaced: true)
            } else if !(model.log.isEmpty && model.inFlight.isEmpty) {
                Text(verbatim: "\(model.log.count + model.inFlight.count) requests")
                    .font(.system(size: 11, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(theme.secondaryLabel)
            }
            Spacer()
            HStack(spacing: 4) {
                Button { model.isOpen = false } label: { Image(systemName: "minus") }
                    .help("Minimise").accessibilityLabel("Minimise")
                Button { model.isOpen = false } label: { Image(systemName: "xmark") }
                    .help("Close").accessibilityLabel("Close")
            }
            .buttonStyle(.vision(.ghost, size: .iconXs))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var requests: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                TextField("Filter by endpoint or method…", text: $model.filter)
                    .textFieldStyle(.vision)
                    .accessibilityLabel("Filter by endpoint or method")
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
                let events = model.visibleEvents
                if events.isEmpty {
                    Text("No requests yet").foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(events) { event in
                        NativeAPIRequestRow(event: event, isSelected: model.selectedID == event.id)
                            .contentShape(Rectangle())
                            .onTapGesture { model.selectedID = event.id }
                            .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            if let event = model.selectedEvent {
                Divider()
                NativeAPIRequestDetail(event: event) { model.selectedID = nil }
                    .frame(width: 260)
            }
        }
    }
}

/// RequestList row: method colour, endpoint, in-flight ellipsis or status and duration.
private struct NativeAPIRequestRow: View {
    let event: APIInspectorEvent
    let isSelected: Bool
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            Text(event.method.rawValue).font(.caption.monospaced()).frame(width: 56, alignment: .leading)
                .foregroundStyle(methodColor)
            Text(event.endpoint).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(event.phase == .error ? theme.loss : theme.foreground)
            Spacer(minLength: 4)
            if event.phase == .start {
                Text("…").foregroundStyle(theme.warning).symbolEffect(.pulse)
            } else {
                if let status = event.status {
                    Text(String(status)).font(.caption.monospacedDigit())
                        .foregroundStyle(event.phase == .error ? theme.loss : theme.gain)
                }
                if let duration = event.durationMs {
                    Text(NativeAPIInspectorFormat.duration(duration)).font(.caption.monospacedDigit())
                        .foregroundStyle(duration >= 1000 ? theme.warning : theme.secondaryLabel)
                }
            }
        }
        .frame(height: 30)
        .background(isSelected ? theme.primary.opacity(0.08) : Color.clear)
    }

    private var methodColor: Color {
        switch event.method {
        case .get: return theme.info
        case .post: return theme.success
        case .put, .patch: return theme.warning
        case .delete: return theme.destructive
        case .head, .options: return theme.secondaryLabel
        }
    }
}

/// RequestDetail: label/value rows of one attempt.
private struct NativeAPIRequestDetail: View {
    let event: APIInspectorEvent
    let close: () -> Void
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Request detail").font(.subheadline.weight(.semibold))
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).accessibilityLabel("Close request detail")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    row("Method", event.method.rawValue)
                    row("Endpoint", event.endpoint)
                    row("Request ID", event.requestId, color: theme.secondaryLabel)
                    row("Status", event.status.map(String.init) ?? "—", color: statusColor)
                    row(
                        "Duration", event.durationMs.map { String(format: "%.1f ms", $0) } ?? "—",
                        color: (event.durationMs ?? 0) >= 1000 ? theme.warning : .primary)
                    row("Attempt", String(event.attempt + 1))
                    if let code = event.errorCode { row("Error code", code) }
                    if let message = event.errorMessage { row("Error message", message, color: theme.loss) }
                }
            }
        }
        .padding(10)
    }

    private var statusColor: Color {
        guard let status = event.status else { return .primary }
        return status < 300 ? theme.gain : status < 400 ? theme.warning : theme.loss
    }

    private func row(_ label: String, _ value: String, color: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(theme.secondaryLabel)
            Text(value).font(.caption.monospaced()).foregroundStyle(color ?? theme.foreground).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// MetricsPanel: totals, error rate, query cache, mutations, slow requests and top endpoints.
private struct NativeAPIMetricsView: View {
    let model: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    stat("Total requests", String(model.totalRequests), sub: nil, warn: false)
                    stat(
                        "Error rate", model.errorRate.formatted(.percent.precision(.fractionLength(1))),
                        sub: "\(model.errorCount) errors", warn: model.errorRate > 0.05)
                    let queries = model.queries.values
                    stat(
                        "Queries", String(queries.count),
                        sub: "\(queries.filter(\.isFetching).count) fetching", warn: false)
                    let total = model.mutationSuccess + model.mutationError
                    stat(
                        "Mutations", "\(model.mutationSuccess)/\(total)", sub: "success / total",
                        warn: model.mutationError > 0)
                }
                section("Slow requests (>1 s) — \(model.slowRequests.count)") {
                    ForEach(model.slowRequests.prefix(10)) { event in
                        HStack {
                            Text(event.method.rawValue).font(.caption.monospaced()).frame(width: 56, alignment: .leading)
                            Text(event.endpoint).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(String(format: "%.2fs", (event.durationMs ?? 0) / 1000)).font(.caption.monospacedDigit())
                                .foregroundStyle(theme.warning)
                        }
                    }
                }
                section("Top endpoints by call count") {
                    ForEach(model.topEndpoints.prefix(10)) { stats in
                        HStack(spacing: 8) {
                            Text(stats.key).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text("\(stats.count)×").font(.caption.monospacedDigit())
                            Text("p95:\(Int(stats.p95.rounded()))ms").font(.caption.monospacedDigit())
                                .foregroundStyle(stats.p95 >= 1000 ? theme.warning : theme.secondaryLabel)
                            if stats.errorCount > 0 {
                                Text("\(stats.errorCount)err").font(.caption.monospacedDigit()).foregroundStyle(theme.loss)
                            }
                        }
                    }
                }
                Button("Reset all metrics", role: .destructive) { model.reset() }
                    .buttonStyle(.visionOutline)
            }
            .padding(12)
        }
    }

    private func stat(_ title: String, _ value: String, sub: String?, warn: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(value).font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(warn ? theme.warning : theme.foreground)
            if let sub { Text(sub).font(.caption2).foregroundStyle(theme.secondaryLabel) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        // A compact `Card`.
        .visionCardBackground()
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.weight(.semibold))
            content()
        }
    }
}

/// The native counterpart of React Query Devtools: one entry per GET endpoint with its
/// fetch state, last status, last update and failures.
private struct NativeAPIQueriesView: View {
    let model: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let entries = model.sortedQueries
        if entries.isEmpty {
            Text("No queries yet").foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(entries) { entry in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Circle().fill(color(entry)).frame(width: 7, height: 7)
                        Text(entry.key).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                    }
                    HStack(spacing: 10) {
                        Text(entry.isFetching ? "fetching" : entry.lastError == nil ? "fresh" : "error")
                        Text("\(entry.fetchCount) fetches")
                        if entry.errorCount > 0 { Text("\(entry.errorCount) errors").foregroundStyle(theme.loss) }
                        if let updated = entry.lastUpdated {
                            Text(updated, style: .relative)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(theme.secondaryLabel)
                    if let error = entry.lastError {
                        Text(error).font(.caption2).foregroundStyle(theme.loss).lineLimit(2)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func color(_ entry: NativeAPIInspectorModel.QueryEntry) -> Color {
        if entry.isFetching { return theme.info }
        return entry.lastError == nil ? theme.gain : theme.loss
    }
}

enum NativeAPIInspectorFormat {
    /// `< 1000 → "Xms"`, otherwise `"X.XXs"`.
    static func duration(_ milliseconds: Double) -> String {
        milliseconds < 1000 ? "\(Int(milliseconds.rounded()))ms" : String(format: "%.2fs", milliseconds / 1000)
    }
}
