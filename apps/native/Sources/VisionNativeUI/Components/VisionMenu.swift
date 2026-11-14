import SwiftUI
import VisionNativeCore

/// The web `DropdownMenu` (components/ui/dropdown-menu.tsx) in place of an AppKit menu: an in-page
/// `glass-thick rounded-card p-1.5` popover whose items show their icon (`mr-2 h-4 w-4
/// text-label-secondary`), a `bg-primary/10` hover row, and destructive items in the destructive
/// colour (`variant="destructive"`, icon included). A `Label` whose title holds a second `Text`
/// shows it as the item's helper line (`type-footnote text-label-secondary`).
///
/// Use it like `Menu` for menus of `Button`s, `Divider`s, `VisionMenuLabel`s and `Toggle`s; a
/// `Toggle` is a `DropdownMenuCheckboxItem` (a primary check in the `pl-8` gutter), or a
/// `DropdownMenuRadioItem` (a primary dot) under `.environment(\.visionMenuRadio, true)`. A menu
/// that holds `Picker`s stays a `Menu`. Buttons keep their role and `.disabled`; choosing an item
/// (a toggle too, as Radix does) closes the popover first, then runs its action. Escape or a
/// click outside closes it.
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
        .toggleStyle(VisionMenuToggleStyle())
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

/// `DropdownMenuLabel`: `px-2 py-1.5 eyebrow` (11 pt medium, upper case, 0.12 em tracking,
/// `muted-foreground/0.8`).
struct VisionMenuLabel: View {
    let text: String
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium)).tracking(11 * 0.12).textCase(.uppercase)
            .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
            .padding(.horizontal, 8).padding(.vertical, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// `DropdownMenuCheckboxItem` / `DropdownMenuRadioItem`: an item row (`py-1.5 pl-8 pr-2`) whose
/// `left-2` slot shows a 16 pt primary check, or an 8 pt primary dot for a radio item, while on.
private struct VisionMenuToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionMenuToggleRow(configuration: configuration)
    }
}

private struct VisionMenuToggleRow: View {
    let configuration: ToggleStyleConfiguration
    @Environment(\.visionMenuRadio) private var radio
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 0) {
                Group {
                    if configuration.isOn {
                        if radio {
                            Circle().fill(theme.primary).frame(width: 8, height: 8)
                        } else {
                            Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(theme.primary)
                        }
                    }
                }
                .frame(width: 24, alignment: .leading).padding(.leading, radio ? 3 : 1)
                .accessibilityHidden(true)
                configuration.label
            }
        }
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}

extension EnvironmentValues {
    /// Set by a `VisionMenu` item for its label: the icon takes the destructive colour.
    @Entry var visionMenuItemDestructive = false
    /// Draws the `Toggle`s of a `VisionMenu` as radio items.
    @Entry var visionMenuRadio = false
}
