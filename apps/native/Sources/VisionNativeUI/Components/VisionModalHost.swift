import SwiftUI
import VisionNativeCore

/// What a presenter draws: the three Radix surfaces of components/ui.
enum VisionModalKind {
    /// `Dialog` (dialog.tsx): centred glass panel, `modal-overlay`.
    case dialog
    /// `AlertDialog` (alert-dialog.tsx): centred glass panel, `modal-overlay-strong`, no scrim dismissal.
    case alert
    /// `Sheet side="right"` (sheet.tsx): edge drawer, `modal-overlay`.
    case sideSheet
}

/// Presents a panel over the view it modifies, in the same window: a scrim, the glass panel, the
/// enter and exit motion, key handling and accessibility. The shared engine of `visionDialog`,
/// `visionAlert`, `visionConfirmationDialog` and `visionSideSheet`.
///
/// - Scrim: `--background` at `Overlay.scrim` (`.modal-overlay`, index.css). With Full effects on
///   (`visionFullEffects`) or the enhanced tier it is `Overlay.scrimFrosted` (`Overlay.scrimFrostedStrong`
///   for alerts) and the presenting view is blurred by `Overlay.blur` (`:root.fx-full .modal-overlay`
///   and the enhanced-tier rule, index.css). SwiftUI has no backdrop filter with a chosen radius,
///   so the blur is on the content under the scrim, not on the scrim.
/// - Enter: scale `Overlay.enterScale` and `Overlay.enterOffsetY` to rest on `Spring.smooth`
///   (`animate-dialog-in`). Exit: `Overlay.exitScale`/`exitOffsetY` over `Duration.dismiss` on
///   `Ease.glide` (`animate-dialog-out`, without the genie origin, which needs the trigger's frame).
///   A side sheet slides in over `Duration.slow` and out over `Duration.normal` on `Ease.outExpo`.
///   Reduce Motion presents and dismisses at once (`motion-reduce:animate-none`); there is no
///   scale or offset to animate.
/// - Reduce Transparency: the panel is a `VisionGlassSurface`, which swaps its material for
///   `--card` at `Glass.reducedTransparencyOpacity`.
/// - Keys and focus: the presenting view is disabled and hidden from VoiceOver while the panel is
///   up, so focus cannot leave it. Escape closes (unless dismissal is disabled) after any
///   handler inside the panel has had its turn. A click on the scrim closes dialogs and sheets,
///   unless dismissal is disabled; never an alert.
/// - Accessibility: the panel is a modal container with the title as its label, and the title is
///   announced when it appears.
struct VisionModalPresenter<Panel: View>: ViewModifier {
    let kind: VisionModalKind
    @Binding var isPresented: Bool
    let metrics: VisionDialogMetrics
    let dismissDisabled: Bool
    let accessibilityTitle: String?
    let onDismiss: (() -> Void)?
    let panel: () -> Panel

    init(
        kind: VisionModalKind, isPresented: Binding<Bool>, metrics: VisionDialogMetrics, dismissDisabled: Bool,
        accessibilityTitle: String?, onDismiss: (() -> Void)?, @ViewBuilder panel: @escaping () -> Panel
    ) {
        self.kind = kind
        _isPresented = isPresented
        self.metrics = metrics
        self.dismissDisabled = dismissDisabled
        self.accessibilityTitle = accessibilityTitle
        self.onDismiss = onDismiss
        self.panel = panel
    }

    /// The panel is in the tree: from presentation until the exit motion ends.
    @State private var mounted = false
    /// The panel is at rest; `false` is the entering and leaving pose.
    @State private var shown = false
    @State private var contentDisablesDismissal = false
    @State private var exitTask: Task<Void, Never>?
    @FocusState private var panelFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.visionFullEffects) private var fullEffects
    @Environment(\.visionVisualEffects) private var visualEffects
    @Environment(\.visionTheme) private var theme

    /// `:root.fx-full .modal-overlay` or the enhanced tier's frosted rule.
    private var frosted: Bool { !theme.isPrintReport && (fullEffects || visualEffects == "enhanced") }

    private var scrimOpacity: Double {
        guard frosted else { return DesignTokens.Overlay.scrim }
        return kind == .alert ? DesignTokens.Overlay.scrimFrostedStrong : DesignTokens.Overlay.scrimFrosted
    }

    private var enterAnimation: Animation? {
        if reduceMotion { return nil }
        switch kind {
        case .sideSheet: return .visionCurve(DesignTokens.Ease.outExpo, duration: DesignTokens.Duration.slow)
        default: return .visionSpring(DesignTokens.Spring.smooth)
        }
    }

    private var exitDuration: Double {
        kind == .sideSheet ? DesignTokens.Duration.normal : DesignTokens.Duration.dismiss
    }

    private var exitAnimation: Animation? {
        if reduceMotion { return nil }
        let curve = kind == .sideSheet ? DesignTokens.Ease.outExpo : DesignTokens.Ease.glide
        return .visionCurve(curve, duration: exitDuration)
    }

    private var dismissalBlocked: Bool { dismissDisabled || contentDisablesDismissal }

    func body(content: Content) -> some View {
        content
            .blur(radius: frosted && shown ? CGFloat(DesignTokens.Overlay.blur) : 0)
            .disabled(isPresented)
            .accessibilityHidden(mounted)
            .overlay { if mounted { layer } }
            .onChange(of: isPresented, initial: true) { _, presented in sync(presented) }
    }

    private var layer: some View {
        GeometryReader { proxy in
            ZStack(alignment: kind == .sideSheet ? .trailing : .center) {
                scrim
                placed(in: proxy.size)
            }
        }
        .ignoresSafeArea()
    }

    private var scrim: some View {
        Color(token: theme.palette.background, opacity: scrimOpacity)
            .opacity(shown ? 1 : 0)
            .contentShape(Rectangle())
            .onTapGesture { if kind != .alert { requestDismiss() } }
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private func placed(in size: CGSize) -> some View {
        switch kind {
        case .sideSheet:
            VisionSideSheet(available: size) { panelContent }
                .modifier(modalTraits)
                .offset(x: shown ? 0 : size.width)
        case .dialog, .alert:
            VisionGlassDialog(metrics: metrics, available: size) { panelContent }
                .modifier(modalTraits)
                .opacity(shown ? 1 : 0)
                .scaleEffect(shown ? 1 : (leaving ? exitScale : enterScale))
                .offset(y: shown ? 0 : (leaving ? exitOffset : enterOffset))
        }
    }

    /// The pose before the panel has appeared and after it starts to leave differ, so which one
    /// `shown == false` means is tracked by whether the model still asks for the panel.
    private var leaving: Bool { !isPresented }
    private var enterScale: CGFloat { reduceMotion ? 1 : CGFloat(DesignTokens.Overlay.enterScale) }
    private var exitScale: CGFloat { reduceMotion ? 1 : CGFloat(DesignTokens.Overlay.exitScale) }
    private var enterOffset: CGFloat { reduceMotion ? 0 : CGFloat(DesignTokens.Overlay.enterOffsetY) }
    private var exitOffset: CGFloat { reduceMotion ? 0 : CGFloat(DesignTokens.Overlay.exitOffsetY) }

    private var panelContent: some View {
        panel()
            .environment(\.visionDismissDialog, VisionDialogDismiss { isPresented = false })
            .backgroundPreferenceValue(VisionInteractiveDismissDisabledKey.self) { disabled in
                Color.clear.onChange(of: disabled, initial: true) { _, next in contentDisablesDismissal = next }
            }
    }

    private var modalTraits: VisionModalTraits {
        VisionModalTraits(title: accessibilityTitle, panelFocused: $panelFocused, onExit: requestDismiss)
    }

    private func requestDismiss() {
        guard !dismissalBlocked else { return }
        isPresented = false
    }

    /// Follows the model's request: mount and animate in, or animate out and unmount.
    private func sync(_ presented: Bool) {
        exitTask?.cancel()
        exitTask = nil
        if presented {
            mounted = true
            if reduceMotion {
                shown = true
            } else {
                let animation = enterAnimation
                Task { @MainActor in
                    // One frame in the entering pose, so the spring has something to move from.
                    await Task.yield()
                    guard isPresented else { return }
                    withAnimation(animation) { shown = true }
                }
            }
        } else if mounted {
            if reduceMotion {
                finishDismissal()
            } else {
                withAnimation(exitAnimation) { shown = false }
                let duration = exitDuration
                exitTask = Task { @MainActor in
                    try? await Task.sleep(for: .seconds(duration))
                    guard !Task.isCancelled, !isPresented else { return }
                    finishDismissal()
                }
            }
        }
    }

    private func finishDismissal() {
        shown = false
        mounted = false
        contentDisablesDismissal = false
        onDismiss?()
    }
}

/// Modal container semantics, Escape and the focus landing of a presented panel.
private struct VisionModalTraits: ViewModifier {
    let title: String?
    var panelFocused: FocusState<Bool>.Binding
    let onExit: () -> Void

    func body(content: Content) -> some View {
        let base = content
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            // Focus stays in the panel: it is the landing for Escape when no control inside has
            // focus, and a control that takes focus itself (a search field) wins over it.
            .focusSection()
            .focusable()
            .focused(panelFocused)
            .focusEffectDisabled()
            .defaultFocus(panelFocused, true)
            .onExitCommand(perform: onExit)
            .task {
                if let title, !title.isEmpty { AccessibilityNotification.Announcement(title).post() }
            }
        if let title, !title.isEmpty {
            base.accessibilityLabel(title)
        } else {
            base
        }
    }
}

/// `visionDialog(item:)`: presents while the item is non-nil and keeps the last item through the
/// exit motion, so the content does not blank while it fades.
struct VisionItemModal<Item: Identifiable, Panel: View>: ViewModifier {
    let kind: VisionModalKind
    @Binding var item: Item?
    let metrics: VisionDialogMetrics
    let dismissDisabled: Bool
    let accessibilityTitle: String?
    let onDismiss: (() -> Void)?
    let build: (Item) -> Panel
    @State private var retained: Item?

    init(
        kind: VisionModalKind, item: Binding<Item?>, metrics: VisionDialogMetrics, dismissDisabled: Bool,
        accessibilityTitle: String?, onDismiss: (() -> Void)?, @ViewBuilder build: @escaping (Item) -> Panel
    ) {
        self.kind = kind
        _item = item
        self.metrics = metrics
        self.dismissDisabled = dismissDisabled
        self.accessibilityTitle = accessibilityTitle
        self.onDismiss = onDismiss
        self.build = build
    }

    func body(content: Content) -> some View {
        content
            .modifier(
                VisionModalPresenter(
                    kind: kind,
                    isPresented: Binding(
                        get: { item != nil },
                        set: { if !$0 { item = nil } }),
                    metrics: metrics, dismissDisabled: dismissDisabled,
                    accessibilityTitle: accessibilityTitle,
                    onDismiss: {
                        retained = nil
                        onDismiss?()
                    }
                ) {
                    if let current = item ?? retained { build(current) }
                })
            .onChange(of: item?.id, initial: true) { _, _ in if let item { retained = item } }
    }
}
