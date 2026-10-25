import SwiftUI
import VisionNativeCore

// The centred glass dialog primitive and its migration helpers (phase 2a, package B).
//
// SwiftUI's `.sheet`, `.alert` and `.confirmationDialog` draw system chrome. The web draws a
// centred `glass-thick` panel over a scrim, so these modifiers present the same content in-window
// through `VisionModalPresenter` (VisionModalHost.swift). Each one keeps the SwiftUI signature it
// replaces, so a call site migrates by renaming.

// MARK: - Dismissal

/// Dismisses the dialog that hosts the reading view. The in-window dialogs are not system
/// presentations, so `@Environment(\.dismiss)` does nothing inside them (`DismissAction` cannot be
/// constructed outside SwiftUI); a header or close control inside a `visionDialog` calls this
/// instead, or passes its own `onClose`.
public struct VisionDialogDismiss {
    private let handler: @MainActor () -> Void

    public init(_ handler: @escaping @MainActor () -> Void) { self.handler = handler }

    @MainActor public func callAsFunction() { handler() }
}

private struct VisionDismissDialogKey: EnvironmentKey {
    static var defaultValue: VisionDialogDismiss { VisionDialogDismiss {} }
}

extension EnvironmentValues {
    /// Closes the nearest enclosing `visionDialog`, `visionAlert`, `visionConfirmationDialog` or
    /// `visionSideSheet`.
    public var visionDismissDialog: VisionDialogDismiss {
        get { self[VisionDismissDialogKey.self] }
        set { self[VisionDismissDialogKey.self] = newValue }
    }
}

/// Marks the hosting dialog as not dismissible by the scrim or Escape, as SwiftUI's
/// `.interactiveDismissDisabled(_:)` does for a sheet. A preference, because the host sits above
/// the content that knows (a report while it submits, onboarding always).
struct VisionInteractiveDismissDisabledKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

extension View {
    /// `.interactiveDismissDisabled(_:)` for a `visionDialog`: while `true`, a click on the scrim
    /// and the host's Escape handling do nothing. The content's own Close and Cancel buttons are
    /// unaffected, like a sheet's.
    public func visionInteractiveDismissDisabled(_ disabled: Bool = true) -> some View {
        preference(key: VisionInteractiveDismissDisabledKey.self, value: disabled)
    }
}

// MARK: - Actions

/// The role of a `VisionDialogAction`, mirroring `ButtonRole` for the two roles dialogs use.
public enum VisionDialogActionRole: Sendable {
    /// The outline Cancel of `AlertDialogCancel`; it answers Escape.
    case cancel
    /// A destructive `AlertDialogAction` (`variant="destructive"`).
    case destructive
}

/// One button of an alert or confirmation dialog: `AlertDialogCancel` (outline, `buttonVariants`
/// outline) or `AlertDialogAction` (the default button, destructive for `.destructive`). It runs
/// its action and then closes the dialog. Replaces `Button(_:role:action:)` inside
/// `.alert`/`.confirmationDialog` actions. List the Cancel first: the footer right-aligns the row
/// with the default action last (`AlertDialogFooter`).
///
/// A non-cancel action answers Return unless `isDefault` is `false`; give it `false` when a
/// dialog has several such actions.
public struct VisionDialogAction: View {
    private let title: String
    private let role: VisionDialogActionRole?
    private let isDefault: Bool
    private let action: @MainActor () -> Void
    @Environment(\.visionDismissDialog) private var dismiss

    public init(
        _ title: String, role: VisionDialogActionRole? = nil, isDefault: Bool = true,
        action: @escaping @MainActor () -> Void = {}
    ) {
        self.title = title
        self.role = role
        self.isDefault = isDefault
        self.action = action
    }

    private var shortcut: KeyboardShortcut? {
        if role == .cancel { return .cancelAction }
        return isDefault ? .defaultAction : nil
    }

    public var body: some View {
        let button = Button(role: role == .destructive ? .destructive : (role == .cancel ? .cancel : nil)) {
            action()
            dismiss()
        } label: {
            Text(title)
        }
        .keyboardShortcut(shortcut)
        if role == .cancel {
            button.buttonStyle(.visionOutline)
        } else {
            button.buttonStyle(.visionPrimary)
        }
    }
}

// MARK: - Geometry

/// How a dialog sizes itself; the defaults are `DialogContent` (dialog.tsx): `max-w-lg`,
/// `max-h-[90vh]`, `p-6`, `gap-5`.
public struct VisionDialogMetrics: Equatable, Sendable {
    public enum Height: Equatable, Sendable {
        /// The content's height, capped at `Overlay.dialogMaxHeightFraction` of the window with the
        /// content scrolling inside (`max-h-[90vh] overflow-y-auto`).
        case fitContent
        /// A fixed share of the window height (`h-[82vh]` for the settings dialog).
        case fraction(Double)
    }

    /// The widest the panel grows; it shrinks to the window less a margin on each side. `nil` lets
    /// the content choose its own width (a view with a fixed frame), without scrolling.
    public var maxWidth: CGFloat?
    public var height: Height
    public var padding: CGFloat
    public var spacing: CGFloat
    /// Side sheets only: the share of the window width the drawer takes before `maxWidth` caps it
    /// (`w-3/4` is 0.75, `w-full` is 1).
    public var sideWidthFraction: CGFloat
    /// Side sheets only: the window edge the drawer slides from (`side="right"` is `.trailing`).
    public var sideEdge: HorizontalEdge

    public init(
        maxWidth: CGFloat? = CGFloat(DesignTokens.Overlay.dialogMaxWidth),
        height: Height = .fitContent,
        padding: CGFloat = CGFloat(DesignTokens.Overlay.dialogPadding),
        spacing: CGFloat = CGFloat(DesignTokens.Overlay.dialogGap),
        sideWidthFraction: CGFloat = 1, sideEdge: HorizontalEdge = .trailing
    ) {
        self.maxWidth = maxWidth
        self.height = height
        self.padding = padding
        self.spacing = spacing
        self.sideWidthFraction = sideWidthFraction
        self.sideEdge = sideEdge
    }

    /// `DialogContent` and `AlertDialogContent` defaults.
    public static let standard = VisionDialogMetrics()

    /// `SheetContent side="right"` defaults (sheet.tsx): `w-3/4 sm:max-w-sm`, `p-6 gap-4`.
    public static let sideSheet = VisionDialogMetrics(
        maxWidth: VisionSideSheet<EmptyView>.defaultMaxWidth, padding: CGFloat(DesignTokens.Overlay.dialogPadding),
        spacing: VisionSideSheet<EmptyView>.gap, sideWidthFraction: VisionSideSheet<EmptyView>.widthFraction)

    /// A right sheet that overrides the width the way the web call sites do, with
    /// `className="w-full sm:max-w-[470px] p-0 gap-0"`: the full window width up to `maxWidth`, and
    /// no padding or gap unless given (the form lays out its own header, scroll area and footer).
    public static func sideSheet(
        maxWidth: CGFloat, padding: CGFloat = 0, spacing: CGFloat = 0, edge: HorizontalEdge = .trailing
    ) -> VisionDialogMetrics {
        VisionDialogMetrics(
            maxWidth: maxWidth, padding: padding, spacing: spacing, sideWidthFraction: 1, sideEdge: edge)
    }
}

// MARK: - Panels

/// The centred glass panel of `DialogContent`/`AlertDialogContent` (components/ui/dialog.tsx,
/// alert-dialog.tsx): `glass-thick`, `rounded-sheet` continuous corners, `p-6 gap-5`, `max-w-lg`,
/// `max-h-[90vh]` with the content scrolling inside. It draws the panel only; the scrim, the
/// enter and exit motion and the key handling are the presenter's.
public struct VisionGlassDialog<Content: View>: View {
    private let metrics: VisionDialogMetrics
    private let available: CGSize
    private let content: Content
    @State private var contentHeight: CGFloat = 0

    /// - Parameter available: The window size the panel is placed in.
    public init(
        metrics: VisionDialogMetrics = .standard, available: CGSize, @ViewBuilder content: () -> Content
    ) {
        self.metrics = metrics
        self.available = available
        self.content = content()
    }

    private var margin: CGFloat { CGFloat(DesignTokens.Overlay.dialogPadding) }
    private var radius: CGFloat { CGFloat(DesignTokens.Overlay.dialogRadius) }
    private var width: CGFloat? {
        metrics.maxWidth.map { min($0, max(available.width - 2 * margin, 0)) }
    }
    private var maxHeight: CGFloat {
        available.height * CGFloat(DesignTokens.Overlay.dialogMaxHeightFraction)
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        panel
            .clipShape(shape)
            .background(VisionGlassSurface(material: .thick, cornerRadius: radius))
    }

    @ViewBuilder private var panel: some View {
        let stack = VStack(alignment: .leading, spacing: metrics.spacing) { content }
            .padding(metrics.padding)
        switch metrics.height {
        case .fraction(let share):
            stack
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .frame(width: width, height: available.height * CGFloat(share))
        case .fitContent:
            if let width {
                ScrollView {
                    stack
                        .frame(width: width, alignment: .leading)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(width: width, height: contentHeight > 0 ? min(contentHeight, maxHeight) : nil)
                // The first frame has no measured height yet; show the panel once it has.
                .opacity(contentHeight > 0 ? 1 : 0)
            } else {
                stack.frame(maxHeight: maxHeight)
            }
        }
    }
}

/// The edge drawer of `SheetContent side="right"` (components/ui/sheet.tsx): `glass-thick`, full
/// height, `w-3/4` up to `sm:max-w-sm`, `rounded-l-sheet`, `p-6 gap-4`. The trailing corners are
/// drawn past the window edge, so only the leading corners show rounded.
public struct VisionSideSheet<Content: View>: View {
    /// `w-3/4` (sheet.tsx side right).
    nonisolated static var widthFraction: CGFloat { 0.75 }
    /// `sm:max-w-sm` (sheet.tsx side right), 24rem.
    nonisolated static var defaultMaxWidth: CGFloat { 384 }
    /// `gap-4` (sheet.tsx variants base).
    nonisolated static var gap: CGFloat { 16 }

    private let available: CGSize
    private let metrics: VisionDialogMetrics
    private let content: Content

    /// - Parameter metrics: The width, padding and gap; `.sideSheet` is `SheetContent`'s own, and
    ///   `.sideSheet(maxWidth:)` the `w-full sm:max-w-[…] p-0 gap-0` the web call sites pass.
    public init(
        available: CGSize, metrics: VisionDialogMetrics = .sideSheet, @ViewBuilder content: () -> Content
    ) {
        self.available = available
        self.metrics = metrics
        self.content = content()
    }

    private var radius: CGFloat { CGFloat(DesignTokens.Overlay.dialogRadius) }

    /// `rounded-r-sheet` on the left edge, `rounded-l-sheet` on the right.
    private var leading: Bool { metrics.sideEdge == .leading }

    public var body: some View {
        let width = min(available.width * metrics.sideWidthFraction, metrics.maxWidth ?? .infinity)
        VStack(alignment: .leading, spacing: metrics.spacing) { content }
            .padding(metrics.padding)
            .frame(width: width, height: available.height, alignment: .topLeading)
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: leading ? 0 : radius, bottomLeadingRadius: leading ? 0 : radius,
                    bottomTrailingRadius: leading ? radius : 0, topTrailingRadius: leading ? radius : 0,
                    style: .continuous)
            )
            .background(
                VisionGlassSurface(material: .thick, cornerRadius: radius)
                    .padding(leading ? .leading : .trailing, -radius)
            )
    }
}

/// The body of an `AlertDialog`: a `type-title-2` title, a `type-body` description in
/// label-secondary, and the footer of actions. Sits inside `VisionGlassDialog`, which supplies
/// the padding.
struct VisionAlertPanel<Actions: View>: View {
    let title: String
    let message: String?
    @ViewBuilder let actions: Actions
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.Overlay.dialogGap)) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.visionCardTitle)
                    .foregroundStyle(theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let message, !message.isEmpty {
                    Text(message)
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VisionDialogFooter { actions }
        }
    }
}

// MARK: - Modifiers

extension View {
    /// A centred glass dialog over the view. Mirrors components/ui/dialog.tsx `Dialog` +
    /// `DialogContent` and replaces `.sheet(isPresented:onDismiss:content:)`; the Close control,
    /// header and footer are the content's (`VisionDialogHeader`, `VisionDialogFooter`).
    ///
    /// The scrim click and Escape close it unless `dismissDisabled` or the content applies
    /// `visionInteractiveDismissDisabled(_:)`. `onDismiss` runs once the exit motion has ended.
    ///
    /// Before and after, from `TransactionsView`:
    ///
    ///     // Before
    ///     .sheet(isPresented: $showImport) { ImportSheet(model: model) }
    ///     // After
    ///     .visionDialog(isPresented: $showImport) { ImportSheet(model: model) }
    ///
    /// Backdrop blur: SwiftUI has no variable-radius backdrop filter, so the frosted scrim of Full
    /// effects (or the enhanced tier) blurs the presenting view itself by
    /// `DesignTokens.Overlay.blur` instead of what is behind the panel. That equals the web
    /// result because the dialog's backdrop is the page, but system chrome outside the SwiftUI
    /// tree (the window titlebar) stays sharp.
    public func visionDialog<Content: View>(
        isPresented: Binding<Bool>, metrics: VisionDialogMetrics = .standard, dismissDisabled: Bool = false,
        accessibilityTitle: String? = nil, onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        modifier(
            VisionModalPresenter(
                kind: .dialog, isPresented: isPresented, metrics: metrics, dismissDisabled: dismissDisabled,
                accessibilityTitle: accessibilityTitle, onDismiss: onDismiss, panel: content))
    }

    /// `visionDialog(isPresented:)` driven by an optional item, replacing
    /// `.sheet(item:onDismiss:content:)`. The item is kept until the exit motion ends so the
    /// content does not blank while it fades.
    public func visionDialog<Item: Identifiable, Content: View>(
        item: Binding<Item?>, metrics: VisionDialogMetrics = .standard, dismissDisabled: Bool = false,
        accessibilityTitle: String? = nil, onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Item) -> Content
    ) -> some View {
        modifier(
            VisionItemModal(
                kind: .dialog, item: item, metrics: metrics, dismissDisabled: dismissDisabled,
                accessibilityTitle: accessibilityTitle, onDismiss: onDismiss, build: content))
    }

    /// A centred alert. Mirrors components/ui/alert-dialog.tsx `AlertDialog` (the strong scrim,
    /// no close X, Cancel outline then the default action) and replaces
    /// `.alert(_:isPresented:actions:message:)`. A click on the scrim does not close it, like
    /// Radix; Escape runs the Cancel action, or just closes when there is none.
    ///
    /// Before and after, from `TransactionsView`:
    ///
    ///     // Before
    ///     .alert(title, isPresented: $confirmDelete) {
    ///         Button(cancel, role: .cancel) {}
    ///         Button(delete, role: .destructive) { model.delete() }
    ///     } message: { Text(message) }
    ///     // After
    ///     .visionAlert(title: title, message: message, isPresented: $confirmDelete) {
    ///         VisionDialogAction(cancel, role: .cancel)
    ///         VisionDialogAction(delete, role: .destructive) { model.delete() }
    ///     }
    public func visionAlert<Actions: View>(
        title: String, message: String? = nil, isPresented: Binding<Bool>,
        @ViewBuilder actions: @escaping () -> Actions
    ) -> some View {
        modifier(
            VisionModalPresenter(
                kind: .alert, isPresented: isPresented, metrics: .standard, dismissDisabled: false,
                accessibilityTitle: title, onDismiss: nil
            ) {
                VisionAlertPanel(title: title, message: message, actions: actions)
            })
    }

    /// An alert driven by an optional item, for `.alert(_:isPresented:presenting:actions:message:)`.
    public func visionAlert<Item: Identifiable, Actions: View>(
        title: String, message: @escaping (Item) -> String? = { _ in nil }, item: Binding<Item?>,
        @ViewBuilder actions: @escaping (Item) -> Actions
    ) -> some View {
        modifier(
            VisionItemModal(
                kind: .alert, item: item, metrics: .standard, dismissDisabled: false,
                accessibilityTitle: title, onDismiss: nil
            ) { current in
                VisionAlertPanel(title: title, message: message(current), actions: { actions(current) })
            })
    }

    /// A centred confirmation. The web has one confirm surface (`useConfirmDialog`, an
    /// `AlertDialog`), so this is `visionAlert` under the name of
    /// `.confirmationDialog(_:isPresented:titleVisibility:actions:message:)`.
    public func visionConfirmationDialog<Actions: View>(
        title: String, message: String? = nil, isPresented: Binding<Bool>,
        @ViewBuilder actions: @escaping () -> Actions
    ) -> some View {
        visionAlert(title: title, message: message, isPresented: isPresented, actions: actions)
    }

    /// `visionConfirmationDialog` for `.confirmationDialog(_:isPresented:presenting:actions:message:)`.
    public func visionConfirmationDialog<Item: Identifiable, Actions: View>(
        title: String, message: @escaping (Item) -> String? = { _ in nil }, item: Binding<Item?>,
        @ViewBuilder actions: @escaping (Item) -> Actions
    ) -> some View {
        visionAlert(title: title, message: message, item: item, actions: actions)
    }

    /// A right-edge drawer. Mirrors components/ui/sheet.tsx `Sheet` + `SheetContent
    /// side="right"` (the `w-3/4 sm:max-w-sm` glass-thick panel with `rounded-l-sheet`, sliding
    /// in over `Duration.slow` and out over `Duration.normal` on `Ease.outExpo`). macOS `.sheet`
    /// is always centred, so this has no SwiftUI signature to replace; it is for the web
    /// `Sheet` call sites.
    ///
    /// `metrics` is `.sideSheet` (`w-3/4 sm:max-w-sm p-6 gap-4`) unless the call site overrides the
    /// width as the web does: `.sideSheet(maxWidth: 470)` for `w-full sm:max-w-[470px] p-0 gap-0`.
    public func visionSideSheet<Content: View>(
        isPresented: Binding<Bool>, metrics: VisionDialogMetrics = .sideSheet, dismissDisabled: Bool = false,
        accessibilityTitle: String? = nil, onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        modifier(
            VisionModalPresenter(
                kind: .sideSheet, isPresented: isPresented, metrics: metrics, dismissDisabled: dismissDisabled,
                accessibilityTitle: accessibilityTitle, onDismiss: onDismiss, panel: content))
    }

    /// `visionSideSheet(isPresented:)` driven by an optional item, like `visionDialog(item:)`: the
    /// item is kept until the slide-out ends so the content does not blank while it leaves.
    public func visionSideSheet<Item: Identifiable, Content: View>(
        item: Binding<Item?>, metrics: VisionDialogMetrics = .sideSheet, dismissDisabled: Bool = false,
        accessibilityTitle: String? = nil, onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Item) -> Content
    ) -> some View {
        modifier(
            VisionItemModal(
                kind: .sideSheet, item: item, metrics: metrics, dismissDisabled: dismissDisabled,
                accessibilityTitle: accessibilityTitle, onDismiss: onDismiss, build: content))
    }
}
