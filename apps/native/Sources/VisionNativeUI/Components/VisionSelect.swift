import SwiftUI
import VisionNativeCore

/// One choosable item of a `VisionSelect` (`SelectItem`).
struct VisionSelectOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    var isDisabled = false
    /// A 12 pt dot before the title, in the trigger and the list (`h-3 w-3 rounded-full`).
    var swatch: Color?
    var id: Value { value }
}

/// What a `VisionSelect` list holds: items, `SelectLabel` group headings and `SelectSeparator` rules.
enum VisionSelectEntry<Value: Hashable> {
    case option(VisionSelectOption<Value>)
    case label(String)
    case separator
}

/// The `Select` (components/ui/select.tsx). The trigger is the input chrome (`h-9 rounded-control
/// border-input/70 bg-background/80 px-3 type-body`, hover/focus states and ring, one line of text
/// and a 16 pt `chevron.down` at 60%). The list is a popover of `glass-thick rounded-card p-1.5`
/// (`VisionGlassSurface(.thick)`), `max-h-96`, at least the trigger width and `min-w-[8rem]`; items
/// are `rounded-[card-6px] py-1.5 pl-8 pr-2 type-body`, the focused row `bg-primary/10`, the chosen
/// one marked with a primary check at the left, `data-[disabled]:opacity-50`.
///
/// Keyboard, as Radix: Return/Space on the trigger opens the list focused on the chosen item; Up and
/// Down move (skipping disabled items), Return selects, Escape closes, typing a letter jumps to the
/// next item starting with it. Hovering a row focuses it. `selection` nil shows `placeholder`
/// (`placeholder:text-label-tertiary`).
///
///     VisionSelect(selection: $currency, options: codes.map { .init(value: $0, title: $0) })
struct VisionSelect<Value: Hashable>: View {
    let selection: Binding<Value?>
    let entries: [VisionSelectEntry<Value>]
    var placeholder = ""
    /// The accessibility label of the trigger (the visible name lives in a `Label` next to it).
    var accessibilityLabel: String?
    /// `w-full`: the trigger fills the available width instead of fitting its title.
    var expands = false

    @Environment(\.visionTheme) private var theme
    @State private var isOpen = false
    @State private var triggerWidth: CGFloat = 0

    init(
        selection: Binding<Value?>, entries: [VisionSelectEntry<Value>], placeholder: String = "",
        accessibilityLabel: String? = nil, expands: Bool = false
    ) {
        self.selection = selection
        self.entries = entries
        self.placeholder = placeholder
        self.accessibilityLabel = accessibilityLabel
        self.expands = expands
    }

    /// Picker-like: a non-optional selection over plain options.
    init(
        selection: Binding<Value>, options: [VisionSelectOption<Value>], placeholder: String = "",
        accessibilityLabel: String? = nil, expands: Bool = false
    ) {
        self.init(
            selection: Binding<Value?>(
                get: { selection.wrappedValue },
                set: { if let value = $0 { selection.wrappedValue = value } }),
            entries: options.map { .option($0) }, placeholder: placeholder,
            accessibilityLabel: accessibilityLabel, expands: expands)
    }

    private var selectedSwatch: Color? {
        for case .option(let option) in entries where option.value == selection.wrappedValue {
            return option.swatch
        }
        return nil
    }

    private var selectedTitle: String? {
        for case .option(let option) in entries where option.value == selection.wrappedValue {
            return option.title
        }
        return nil
    }

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            trigger
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { triggerWidth = $0 }
        .accessibilityValue(selectedTitle ?? placeholder)
        .visionAccessibilityLabel(accessibilityLabel)
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            VisionSelectList(
                entries: entries, selection: selection, minWidth: max(triggerWidth, VisionSelectList<Value>.minWidth),
                dismiss: { isOpen = false })
        }
    }

    private var trigger: some View {
        VisionFieldChrome {
            HStack(spacing: 8) {
                if let swatch = selectedSwatch {
                    Circle().fill(swatch).frame(width: 12, height: 12).accessibilityHidden(true)
                }
                Text(selectedTitle ?? placeholder)
                    .font(VisionControlMetrics.fieldFont)
                    .foregroundStyle(selectedTitle == nil ? theme.tertiaryLabel : theme.foreground)
                    .lineLimit(1)
                if expands { Spacer(minLength: 0) }
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.foreground.opacity(0.6))
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: expands ? .infinity : nil, alignment: .leading)
        }
    }
}

/// The popover content of a `VisionSelect`: `SelectContent` + `SelectViewport` + items.
private struct VisionSelectList<Value: Hashable>: View {
    let entries: [VisionSelectEntry<Value>]
    let selection: Binding<Value?>
    let minWidth: CGFloat
    let dismiss: () -> Void

    @Environment(\.visionTheme) private var theme
    @FocusState private var focused: Int?
    @State private var contentHeight: CGFloat = 0

    /// `min-w-[8rem]`.
    static var minWidth: CGFloat { 128 }
    /// `max-h-96`.
    private static var maxHeight: CGFloat { 384 }
    /// `p-1.5`.
    private let padding: CGFloat = 6

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(entries.indices, id: \.self) { index in
                    row(index)
                }
            }
            .padding(padding)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .frame(minWidth: minWidth)
        .frame(height: contentHeight > 0 ? min(contentHeight, Self.maxHeight) : nil)
        .background(
            VisionGlassSurface(material: .thick, cornerRadius: CGFloat(DesignTokens.Radius.card))
        )
        .presentationBackground(.clear)
        .task { focused = initialFocus }
    }

    private var initialFocus: Int? {
        entries.indices.first { index in
            if case .option(let option) = entries[index] { return option.value == selection.wrappedValue }
            return false
        } ?? enabledIndices.first
    }

    private var enabledIndices: [Int] {
        entries.indices.filter { index in
            if case .option(let option) = entries[index] { return !option.isDisabled }
            return false
        }
    }

    @ViewBuilder
    private func row(_ index: Int) -> some View {
        switch entries[index] {
        case .option(let option):
            optionRow(option, index: index)
        case .label(let text):
            // `py-1.5 pl-8 pr-2 eyebrow`
            Text(text)
                .font(VisionFonts.body(CGFloat(DesignTokens.Typography.caption.size), weight: 600, relativeTo: .caption))
                .foregroundStyle(theme.secondaryLabel)
                .padding(.vertical, 6)
                .padding(.leading, 32)
                .padding(.trailing, 8)
                .accessibilityAddTraits(.isHeader)
        case .separator:
            // `-mx-1 my-1 h-px bg-border/60`
            Rectangle()
                .fill(Color(token: theme.palette.border, opacity: 0.6))
                .frame(height: 1)
                .padding(.vertical, 4)
                .padding(.horizontal, -4)
                .accessibilityHidden(true)
        }
    }

    private func optionRow(_ option: VisionSelectOption<Value>, index: Int) -> some View {
        let radius = CGFloat(DesignTokens.Radius.card) - padding
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let isChosen = option.value == selection.wrappedValue
        return Button {
            choose(option)
        } label: {
            ZStack(alignment: .leading) {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.primary)
                    .frame(width: 16)
                    .padding(.leading, 8)
                    .opacity(isChosen ? 1 : 0)
                    .accessibilityHidden(true)
                HStack(spacing: 8) {
                    if let swatch = option.swatch {
                        Circle().fill(swatch).frame(width: 12, height: 12).accessibilityHidden(true)
                    }
                    Text(option.title)
                        .font(VisionControlMetrics.fieldFont)
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                }
                    .padding(.leading, 32)
                    .padding(.trailing, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            .background(shape.fill(theme.primary.opacity(focused == index ? 0.1 : 0)))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(option.isDisabled)
        .opacity(option.isDisabled ? VisionControlMetrics.disabledOpacity : 1)
        .focused($focused, equals: index)
        .onHover { if $0 && !option.isDisabled { focused = index } }
        .onMoveCommand { direction in move(direction, from: index) }
        .onKeyPress(.return) {
            guard !option.isDisabled else { return .ignored }
            choose(option)
            return .handled
        }
        .onKeyPress(characters: .alphanumerics) { press in
            typeahead(press.characters, from: index)
        }
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }

    private func choose(_ option: VisionSelectOption<Value>) {
        selection.wrappedValue = option.value
        dismiss()
    }

    private func move(_ direction: MoveCommandDirection, from index: Int) {
        let enabled = enabledIndices
        guard !enabled.isEmpty else { return }
        switch direction {
        case .up: focused = enabled.last { $0 < index } ?? enabled.last
        case .down: focused = enabled.first { $0 > index } ?? enabled.first
        default: break
        }
    }

    /// Radix typeahead: the next enabled item whose title starts with the typed text.
    private func typeahead(_ typed: String, from index: Int) -> KeyPress.Result {
        let enabled = enabledIndices
        let after = enabled.filter { $0 > index } + enabled.filter { $0 <= index }
        for candidate in after {
            if case .option(let option) = entries[candidate],
                option.title.range(of: typed, options: [.anchored, .caseInsensitive, .diacriticInsensitive]) != nil
            {
                focused = candidate
                return .handled
            }
        }
        return .ignored
    }
}
