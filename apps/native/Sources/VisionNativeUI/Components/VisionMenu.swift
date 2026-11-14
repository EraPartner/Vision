import SwiftUI
import VisionNativeCore

/// The web `DropdownMenu` (components/ui/dropdown-menu.tsx) in place of an AppKit menu: an in-page
/// `glass-thick rounded-card p-1.5` popover whose items show their icon (`mr-2 h-4 w-4
/// text-label-secondary`), a `bg-primary/10` hover row, and destructive items in the destructive
/// colour (`variant="destructive"`, icon included). A `Label` whose title holds a second `Text`
/// shows it as the item's helper line (`type-footnote text-label-secondary`).
///
/// Use it like `Menu` for menus of `Button`s and `Divider`s; a menu that holds `Toggle`s or
/// `Picker`s stays a `Menu`. Buttons keep their role and `.disabled`; choosing an item closes the
/// popover first, then runs its action. Escape or a click outside closes it.
///
///     VisionMenu {
///         Button { edit() } label: { Label("Edit", systemImage: "pencil") }
///         Divider()
///         Button(role: .destructive) { delete() } label: { Label("Delete", systemImage: "trash") }
///     } label: {
///         Image(systemName: "ellipsis")
///     }
struct VisionMenu<Content: View, MenuLabel: View>: View {
    private let content: () -> Content
    private let label: () -> MenuLabel
    @State private var isOpen = false

    init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder label: @escaping () -> MenuLabel) {
        self.content = content
        self.label = label
    }

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            label()
        }
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            VisionMenuPanel(dismiss: { isOpen = false }, content: content)
        }
    }
}

/// `DropdownMenuContent`: `min-w-[8rem] p-1.5` on `glass-thick`.
private struct VisionMenuPanel<Content: View>: View {
    let dismiss: () -> Void
    let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .buttonStyle(VisionMenuItemStyle(dismiss: dismiss))
        .labelStyle(VisionMenuItemLabelStyle())
        .padding(6)
        .frame(minWidth: 128, alignment: .leading)
        .fixedSize()
        .background(VisionGlassSurface(material: .thick, cornerRadius: CGFloat(DesignTokens.Radius.card)))
        .presentationBackground(.clear)
    }
}

/// `DropdownMenuItem`: `rounded-[card-6px] px-2 py-1.5 type-body`, `focus:bg-primary/10`
/// (destructive: `text-destructive focus:bg-destructive/10`), `data-[disabled]:opacity-50`.
private struct VisionMenuItemStyle: PrimitiveButtonStyle {
    let dismiss: () -> Void

    func makeBody(configuration: Configuration) -> some View {
        VisionMenuItem(configuration: configuration, dismiss: dismiss)
    }
}

private struct VisionMenuItem: View {
    let configuration: PrimitiveButtonStyleConfiguration
    let dismiss: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let destructive = configuration.role == .destructive
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.card) - 6, style: .continuous)
        let highlight = destructive ? theme.destructive : theme.primary
        Button {
            dismiss()
            configuration.trigger()
        } label: {
            VStack(alignment: .leading, spacing: 1) { configuration.label }
                .font(VisionControlMetrics.fieldFont)
                .foregroundStyle(destructive ? theme.destructive : theme.foreground)
                .environment(\.visionMenuItemDestructive, destructive)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(shape.fill(highlight.opacity(hovering && isEnabled ? 0.1 : 0)))
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
        .onHover { inside in
            if hovering != inside { hovering = inside }
        }
    }
}

/// The item's icon (`mr-2 h-4 w-4`, secondary unless the item is destructive), then its title;
/// a second `Text` in the title is the helper line.
private struct VisionMenuItemLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionMenuItemLabel(configuration: configuration)
    }
}

private struct VisionMenuItemLabel: View {
    let configuration: LabelStyleConfiguration
    @Environment(\.visionMenuItemDestructive) private var destructive
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon
                .font(.system(size: 13))
                .foregroundStyle(destructive ? theme.destructive : theme.secondaryLabel)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                configuration.title
            }
            .lineLimit(1)
        }
    }
}

extension EnvironmentValues {
    /// Set by a `VisionMenu` item for its label: the icon takes the destructive colour.
    @Entry var visionMenuItemDestructive = false
}
