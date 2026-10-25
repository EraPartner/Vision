import SwiftUI
import VisionNativeCore

/// One segment of a `VisionSegmentedControl` (`SegmentedControlItem`).
struct VisionSegmentOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    /// An SF Symbol shown before the title (`gap-1.5`); `title` stays the accessibility label.
    var systemImage: String?
    var isDisabled = false
    var id: Value { value }
}

/// `size` of `segmentedControlVariants`: `h-9` or `h-8`.
enum VisionSegmentedControlSize: Sendable {
    case `default`
    case sm

    var height: CGFloat {
        switch self {
        case .default: return VisionControlMetrics.heightDefault
        case .sm: return VisionControlMetrics.heightSm
        }
    }
}

/// Casts the drop layers of an elevation token (`DesignTokens.Elevation`, `shadow-elevation-N`);
/// the inset highlight layer is skipped, as a shape fill carries no inset. CSS blur is twice a
/// SwiftUI radius and the negative spread is not applied.
struct VisionElevationShadow: ViewModifier {
    let layers: AppearanceValue<[ShadowLayer]>
    @Environment(\.visionTheme) private var theme

    func body(content: Content) -> some View {
        let drops = layers.value(isDark: theme.isDark).filter { !$0.inset }
        drops.reduce(AnyView(content)) { view, layer in
            AnyView(
                view.shadow(
                    color: Color(token: theme.selection.color(layer.color), opacity: layer.alpha),
                    radius: layer.blur / 2, x: layer.x, y: layer.y))
        }
    }
}

extension View {
    /// `shadow-elevation-N`.
    func visionElevation(_ layers: AppearanceValue<[ShadowLayer]>) -> some View {
        modifier(VisionElevationShadow(layers: layers))
    }
}

/// The `SegmentedControl` (components/ui/segmented-control.tsx): `inline-flex max-w-full
/// items-center rounded-control bg-foreground/[0.06] p-0.5 text-label-secondary` at `h-9` (`h-8`
/// small), with one `bg-background shadow-elevation-1 ring-1 ring-foreground/[0.06]` pill that
/// glides between segments on the snappy spring (`matchedGeometryEffect`; no animation under
/// Reduce Motion). Segments are `px-3 type-body font-medium rounded-[control-2px]`, `hover:text-foreground`,
/// `disabled:opacity-50`, with the focus ring. Like Radix ToggleGroup in single mode it is a picker,
/// never a toggle: clicking the chosen segment keeps it, Left/Up and Right/Down move the choice
/// (wrapping, skipping disabled segments) and VoiceOver reads a labelled group of selectable items.
/// `label` renders a `Label` above the control (the `label` prop).
///
///     VisionSegmentedControl(selection: $range, options: ranges.map { .init(value: $0, title: name($0)) })
struct VisionSegmentedControl<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [VisionSegmentOption<Value>]
    var size: VisionSegmentedControlSize = .default
    var label: String?
    /// The per-item `className="px-2.5 type-footnote"` the web passes for dense toolbars: 10pt
    /// side padding and `type-footnote` instead of `px-3 type-body`.
    var compact = false

    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var pillSpace
    @FocusState private var focus: Value?

    init(
        selection: Binding<Value>, options: [VisionSegmentOption<Value>],
        size: VisionSegmentedControlSize = .default, label: String? = nil, compact: Bool = false
    ) {
        _selection = selection
        self.options = options
        self.size = size
        self.label = label
        self.compact = compact
    }

    /// Picker-like: `values` shown with `title(value)`.
    init(
        selection: Binding<Value>, values: [Value], title: (Value) -> String,
        size: VisionSegmentedControlSize = .default, label: String? = nil, compact: Bool = false
    ) {
        self.init(
            selection: selection,
            options: values.map { VisionSegmentOption(value: $0, title: title($0)) },
            size: size, label: label, compact: compact)
    }

    var body: some View {
        if let label {
            VStack(alignment: .leading, spacing: 8) {
                Text(label)
                    .font(VisionFonts.body(CGFloat(DesignTokens.Typography.callout.size), weight: 500, relativeTo: .callout))
                    .foregroundStyle(theme.foreground)
                track
            }
        } else {
            track
        }
    }

    private var track: some View {
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        return HStack(spacing: 0) {
            ForEach(options) { option in
                segment(option)
            }
        }
        .padding(trackPadding)
        .frame(height: size.height)
        .background(shape.fill(theme.foreground.opacity(0.06)))
        .animation(VisionControlMetrics.snappySpring(reduceMotion: reduceMotion), value: selection)
        .accessibilityElement(children: .contain)
        .visionAccessibilityLabel(label)
    }

    /// `p-0.5`.
    private let trackPadding: CGFloat = 2

    /// `rounded-[calc(var(--radius-control)-0.125rem)]`: concentric with the track.
    private var segmentRadius: CGFloat { VisionControlMetrics.radius - trackPadding }

    private func segment(_ option: VisionSegmentOption<Value>) -> some View {
        let isSelected = option.value == selection
        return Button {
            selection = option.value
        } label: {
            HStack(spacing: 6) {
                if let symbol = option.systemImage {
                    Image(systemName: symbol).accessibilityHidden(true)
                }
                Text(option.title).lineLimit(1)
            }
        }
        .buttonStyle(
            VisionSegmentButtonStyle(
                isSelected: isSelected, radius: segmentRadius, namespace: pillSpace,
                isDimmed: !isEnabled || option.isDisabled, compact: compact)
        )
        .disabled(option.isDisabled)
        .focused($focus, equals: option.value)
        .onMoveCommand { direction in move(direction, from: option.value) }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func move(_ direction: MoveCommandDirection, from value: Value) {
        let enabled = options.filter { !$0.isDisabled }
        guard let index = enabled.firstIndex(where: { $0.value == value }) else { return }
        let step: Int
        switch direction {
        case .up, .left: step = -1
        case .down, .right: step = 1
        @unknown default: return
        }
        let next = enabled[(index + step + enabled.count) % enabled.count].value
        selection = next
        focus = next
    }
}

/// A segment: label colour, hover, press feedback, the sliding pill and the focus ring.
private struct VisionSegmentButtonStyle: ButtonStyle {
    let isSelected: Bool
    let radius: CGFloat
    let namespace: Namespace.ID
    let isDimmed: Bool
    let compact: Bool

    func makeBody(configuration: Configuration) -> some View {
        SegmentBody(
            configuration: configuration, isSelected: isSelected, radius: radius, namespace: namespace,
            isDimmed: isDimmed, compact: compact)
    }

    private struct SegmentBody: View {
        let configuration: ButtonStyleConfiguration
        let isSelected: Bool
        let radius: CGFloat
        let namespace: Namespace.ID
        let isDimmed: Bool
        let compact: Bool
        @Environment(\.visionTheme) private var theme
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            configuration.label
                .font(
                    compact
                        ? VisionFonts.body(CGFloat(DesignTokens.Typography.footnote.size), weight: 500, relativeTo: .footnote)
                        : VisionFonts.body(CGFloat(DesignTokens.Typography.body.size), weight: 500, relativeTo: .body))
                .foregroundStyle(isSelected || hovering ? theme.foreground : theme.secondaryLabel)
                .padding(.horizontal, compact ? 10 : 12)
                .frame(maxHeight: .infinity)
                .background {
                    if isSelected {
                        shape
                            .fill(theme.background)
                            .overlay(
                                shape.strokeBorder(
                                    theme.foreground.opacity(0.06), lineWidth: VisionControlMetrics.borderWidth)
                            )
                            .visionElevation(DesignTokens.Elevation.level1)
                            .matchedGeometryEffect(id: "pill", in: namespace)
                    }
                }
                .contentShape(shape)
                .visionFocusRing(cornerRadius: radius)
                .opacity(isDimmed ? VisionControlMetrics.disabledOpacity : 1)
                .scaleEffect(configuration.isPressed ? CGFloat(DesignTokens.Press.scale) : 1)
                .animation(VisionControlMetrics.pressTransition(reduceMotion: reduceMotion), value: configuration.isPressed)
                .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
                .onHover { hovering = $0 }
        }
    }
}

extension View {
    /// `accessibilityLabel` when `label` is set, the view unchanged otherwise.
    @ViewBuilder
    func visionAccessibilityLabel(_ label: String?) -> some View {
        if let label { accessibilityLabel(label) } else { self }
    }
}
