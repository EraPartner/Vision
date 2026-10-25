import SwiftUI
import VisionNativeCore

/// Geometry of the toggle primitives (switch.tsx, checkbox.tsx, radio-group.tsx). The 38 x 22 /
/// 18 / 14 sizes are Tailwind `h-[22px] w-[38px]`, `h-[18px] w-[18px]` and `h-3.5` steps that have
/// no token.
private enum VisionToggleMetrics {
    static let switchWidth: CGFloat = 38
    static let switchHeight: CGFloat = 22
    static let switchThumb: CGFloat = 18
    /// `translate-x-[1px]` unchecked, `translate-x-[17px]` checked.
    static let switchThumbOff: CGFloat = 1
    static let switchThumbOn: CGFloat = 17
    static let boxSide: CGFloat = 18
    /// Radio dot: `h-2.5 w-2.5`.
    static let radioDot: CGFloat = 10
    /// Check icon: `h-3.5 w-3.5`, stroke 3.
    static let checkIcon: CGFloat = 11
    /// Gap between a control and its label.
    static let labelGap: CGFloat = 8
    /// `grid gap-2.5` of RadioGroup.
    static let radioGroupGap: CGFloat = 10
}

/// `inset 0 1px 0 0 foreground/alpha`: a 1 pt top edge fading out over the first eighth of the shape.
private func visionInsetTopEdge<S: InsettableShape>(_ shape: S, color: Color) -> some View {
    shape.strokeBorder(
        LinearGradient(
            stops: [
                Gradient.Stop(color: color, location: 0),
                Gradient.Stop(color: color.opacity(0), location: 0.12),
            ],
            startPoint: .top, endPoint: .bottom),
        lineWidth: VisionControlMetrics.borderWidth
    )
    .allowsHitTesting(false)
}

/// The row every toggle style shares: the control and the label as one plain button, so the whole
/// row is the hit target, Space activates it, and VoiceOver reads it as a toggle.
private struct VisionToggleRow<Control: View>: View {
    let configuration: ToggleStyleConfiguration
    let control: Control
    var isRadio = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button {
            if isRadio {
                configuration.isOn = true
            } else {
                configuration.isOn.toggle()
            }
        } label: {
            HStack(spacing: VisionToggleMetrics.labelGap) {
                control
                configuration.label
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
        .accessibilityRepresentation {
            Toggle(isOn: configuration.$isOn) { configuration.label }
                .toggleStyle(.automatic)
        }
    }
}

/// The `Switch` (components/ui/switch.tsx): `h-[22px] w-[38px] rounded-full`, off
/// `bg-foreground/[0.1]`, on `bg-primary` with `inset 0 0 0 1px primary/0.6` and the glow
/// `0 2px 10px -2px primary/0.4`, an 18 pt `bg-background` thumb with `0 1px 3px rgba(0,0,0,.3)`,
/// colour over `--duration-normal` and the thumb on the snappy spring (no animation under Reduce
/// Motion). Use as `.toggleStyle(.visionSwitch)`.
struct VisionSwitchToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionToggleRow(configuration: configuration, control: VisionSwitchControl(isOn: configuration.isOn))
    }
}

private struct VisionSwitchControl: View {
    let isOn: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let track = Capsule()
        ZStack(alignment: .leading) {
            track.fill(isOn ? theme.primary : theme.foreground.opacity(0.1))
                .shadow(color: theme.primary.opacity(isOn ? 0.4 : 0), radius: 5, y: 2)
            // `inset 0 1px 2px foreground/0.08`
            visionInsetTopEdge(track, color: theme.foreground.opacity(0.08))
            if isOn {
                track.strokeBorder(theme.primary.opacity(0.6), lineWidth: VisionControlMetrics.borderWidth)
            }
            thumb
        }
        .frame(width: VisionToggleMetrics.switchWidth, height: VisionToggleMetrics.switchHeight)
        .animation(
            reduceMotion ? nil : .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.normal),
            value: isOn
        )
        .visionFocusRing(in: Capsule())
    }

    private var thumb: some View {
        Circle()
            .fill(theme.background)
            .overlay(visionInsetTopEdge(Circle(), color: theme.foreground.opacity(0.12)))
            .frame(width: VisionToggleMetrics.switchThumb, height: VisionToggleMetrics.switchThumb)
            .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
            .offset(x: isOn ? VisionToggleMetrics.switchThumbOn : VisionToggleMetrics.switchThumbOff)
            .animation(VisionControlMetrics.snappySpring(reduceMotion: reduceMotion), value: isOn)
    }
}

/// The `Checkbox` (components/ui/checkbox.tsx): 18 pt `rounded-chip`, `border-input/80
/// bg-background/40`, `hover:border-primary/60`, checked `border-primary bg-primary` with a 14 pt
/// check (stroke 3) and the glow `0 2px 8px -2px primary/0.35`. Use as `.toggleStyle(.visionCheckbox)`.
struct VisionCheckboxToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionToggleRow(configuration: configuration, control: VisionCheckboxControl(isOn: configuration.isOn))
    }
}

private struct VisionCheckboxControl: View {
    let isOn: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.chip), style: .continuous)
        ZStack {
            shape.fill(isOn ? theme.primary : Color(token: theme.palette.background, opacity: 0.4))
            visionInsetTopEdge(shape, color: theme.foreground.opacity(0.04))
            shape.strokeBorder(border, lineWidth: VisionControlMetrics.borderWidth)
            if isOn {
                Image(systemName: "checkmark")
                    .font(.system(size: VisionToggleMetrics.checkIcon, weight: .heavy))
                    .foregroundStyle(theme.primaryForeground)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: VisionToggleMetrics.boxSide, height: VisionToggleMetrics.boxSide)
        .shadow(color: theme.primary.opacity(isOn ? 0.35 : 0), radius: 4, y: 2)
        .contentShape(shape)
        .visionFocusRing(cornerRadius: CGFloat(DesignTokens.Radius.chip))
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: isOn)
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
        .onHover { hovering = $0 }
    }

    private var border: Color {
        if isOn { return theme.primary }
        if hovering && isEnabled { return theme.primary.opacity(0.6) }
        return Color(token: theme.palette.input, opacity: 0.8)
    }
}

/// The `RadioGroupItem` (components/ui/radio-group.tsx): an 18 pt circle, `border-input/80
/// bg-background/40`, `hover:border-primary/60`, checked `border-primary` with a 10 pt `fill-primary`
/// dot and the glow `0 2px 8px -2px primary/0.35`. As a toggle style, `isOn` means "selected" and a
/// click only selects (a radio is never cleared by clicking it). `VisionRadioGroup` lays out a group.
struct VisionRadioToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionToggleRow(
            configuration: configuration, control: VisionRadioControl(isOn: configuration.isOn), isRadio: true)
    }
}

private struct VisionRadioControl: View {
    let isOn: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        ZStack {
            Circle().fill(Color(token: theme.palette.background, opacity: 0.4))
            visionInsetTopEdge(Circle(), color: theme.foreground.opacity(0.04))
            Circle().strokeBorder(border, lineWidth: VisionControlMetrics.borderWidth)
            if isOn {
                Circle().fill(theme.primary)
                    .frame(width: VisionToggleMetrics.radioDot, height: VisionToggleMetrics.radioDot)
            }
        }
        .frame(width: VisionToggleMetrics.boxSide, height: VisionToggleMetrics.boxSide)
        .shadow(color: theme.primary.opacity(isOn ? 0.35 : 0), radius: 4, y: 2)
        .contentShape(Circle())
        .visionFocusRing(in: Circle())
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: isOn)
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
        .onHover { hovering = $0 }
    }

    private var border: Color {
        if isOn { return theme.primary }
        if hovering && isEnabled { return theme.primary.opacity(0.6) }
        return Color(token: theme.palette.input, opacity: 0.8)
    }
}

extension ToggleStyle where Self == VisionSwitchToggleStyle {
    /// Replaces `.toggleStyle(.switch)`.
    static var visionSwitch: VisionSwitchToggleStyle { VisionSwitchToggleStyle() }
}

extension ToggleStyle where Self == VisionCheckboxToggleStyle {
    /// Replaces `.toggleStyle(.checkbox)`.
    static var visionCheckbox: VisionCheckboxToggleStyle { VisionCheckboxToggleStyle() }
}

extension ToggleStyle where Self == VisionRadioToggleStyle {
    /// One radio item; see `VisionRadioGroup`.
    static var visionRadio: VisionRadioToggleStyle { VisionRadioToggleStyle() }
}

/// One option of a `VisionRadioGroup`.
struct VisionRadioOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    var isDisabled = false
    var id: Value { value }
}

/// The `RadioGroup` (components/ui/radio-group.tsx): `grid gap-2.5` of radio items, exclusive
/// selection, and the arrow-key behaviour of Radix: Up/Left select the previous enabled item and
/// Down/Right the next, wrapping, moving focus with the selection. Replaces
/// `Picker(...).pickerStyle(.radioGroup)`.
struct VisionRadioGroup<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [VisionRadioOption<Value>]
    var label: String?
    @FocusState private var focus: Value?

    init(selection: Binding<Value>, options: [VisionRadioOption<Value>], label: String? = nil) {
        _selection = selection
        self.options = options
        self.label = label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VisionToggleMetrics.radioGroupGap) {
            ForEach(options) { option in
                Toggle(
                    option.title,
                    isOn: Binding(
                        get: { selection == option.value },
                        set: { if $0 { selection = option.value } })
                )
                .toggleStyle(.visionRadio)
                .disabled(option.isDisabled)
                .focused($focus, equals: option.value)
                .onMoveCommand { direction in move(direction, from: option.value) }
            }
        }
        .accessibilityElement(children: .contain)
        .visionAccessibilityLabel(label)
    }

    private func move(_ direction: MoveCommandDirection, from value: Value) {
        let enabled = options.filter { !$0.isDisabled }
        guard let index = enabled.firstIndex(where: { $0.value == value }), !enabled.isEmpty else { return }
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
