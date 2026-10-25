import SwiftUI
import VisionNativeCore

/// `TagInput`: the chosen tags as removable chips; clicking the field opens a popover to
/// search the active tags or create a new one (with a colour). Return or a comma adds or
/// creates the typed tag; Backspace in an empty search removes the last tag.
struct TagField: View {
    let pickers: PickerDataModel
    let selected: [String]
    var disabled = false
    let label: String
    let strings: any Localizing
    let onChange: ([String]) -> Void
    @State var isOpen = false
    @Environment(\.visionTheme) var theme

    var body: some View {
        HStack(spacing: 4) {
            ForEach(selected, id: \.self) { slug in
                TagChip(
                    slug: slug, color: pickers.tag(slug)?.color,
                    removeLabel: strings.t("aria.removeTag", ["tag": slug]),
                    remove: removal(slug))
            }
            if !disabled && selected.count < PickerDataModel.maxTags {
                Button {
                    isOpen = true
                } label: {
                    Image(systemName: "tag")
                        .imageScale(.small)
                        .foregroundStyle(theme.tertiaryLabel)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(label)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .fill(theme.foreground.opacity(0.04)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .strokeBorder(theme.border.opacity(0.7), lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture {
            if !disabled { isOpen = true }
        }
        .opacity(disabled ? 0.5 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .accessibilityValue(selected.joined(separator: ", "))
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            TagPopover(pickers: pickers, selected: selected, strings: strings, onChange: onChange)
                .environment(\.visionTheme, theme)
        }
    }

    /// The chip's remove action, or none while the field is disabled.
    private func removal(_ slug: String) -> (() -> Void)? {
        guard !disabled else { return nil }
        let selected = selected
        let onChange = onChange
        return {
            var state = TagInputState(selected: selected)
            state.remove(slug)
            onChange(state.selected)
        }
    }
}

/// A tag chip tinted with the tag's colour, with an optional remove button.
struct TagChip: View {
    let slug: String
    let color: String?
    var removeLabel: String?
    var remove: (() -> Void)?
    @Environment(\.visionTheme) var theme

    init(slug: String, color: String?, removeLabel: String? = nil, remove: (() -> Void)? = nil) {
        self.slug = slug
        self.color = color
        self.removeLabel = removeLabel
        self.remove = remove
    }

    var body: some View {
        let tint = TagColor.color(color) ?? theme.foreground.opacity(0.8)
        HStack(spacing: 3) {
            Text(slug)
                .font(.caption)
                .lineLimit(1)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(removeLabel ?? slug)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .foregroundStyle(tint)
        .background(Capsule().fill(tint.opacity(0.14)))
        .overlay(Capsule().strokeBorder(tint, lineWidth: 1))
    }
}

/// The colours tags store: the palette's `hsl(h, s%, l%)` strings or `#rrggbb`.
enum TagColor {
    static func color(_ css: String?) -> Color? {
        guard let css = css?.trimmingCharacters(in: .whitespaces), !css.isEmpty else { return nil }
        if css.hasPrefix("hsl(") && css.hasSuffix(")") {
            let parts = css.dropFirst(4).dropLast().split(separator: ",").map {
                Double($0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "%", with: ""))
            }
            guard parts.count == 3, let h = parts[0], let s = parts[1], let l = parts[2] else { return nil }
            // HSL to HSB.
            let lightness = l / 100
            let saturation = s / 100
            let brightness = lightness + saturation * min(lightness, 1 - lightness)
            let hsbSaturation = brightness == 0 ? 0 : 2 * (1 - lightness / brightness)
            return Color(hue: h / 360, saturation: hsbSaturation, brightness: brightness)
        }
        if css.hasPrefix("#"), css.count == 7, let value = Int(css.dropFirst(), radix: 16) {
            return Color(
                red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                blue: Double(value & 0xFF) / 255)
        }
        return nil
    }
}

/// The popover of `TagField`.
struct TagPopover: View {
    let pickers: PickerDataModel
    let strings: any Localizing
    let onChange: ([String]) -> Void
    @State var state: TagInputState
    @State var pendingColor: String
    /// `tags.createFailed` with the API message, after a failed create.
    @State var createError: String? = nil
    @FocusState private var searchFocused: Bool
    @Environment(\.visionTheme) var theme

    init(pickers: PickerDataModel, selected: [String], strings: any Localizing, onChange: @escaping ([String]) -> Void) {
        self.pickers = pickers
        self.strings = strings
        self.onChange = onChange
        _state = State(initialValue: TagInputState(selected: selected))
        _pendingColor = State(initialValue: PickerDataModel.tagPalette.randomElement()?.color ?? "hsl(355, 60%, 52%)")
    }

    var body: some View {
        let suggestions = pickers.tagSuggestions(typed: state.typed, selected: state.selected)
        let canCreate = state.canCreate(existing: pickers.tags)
        VStack(alignment: .leading, spacing: 6) {
            TextField(strings.t("tags.searchPlaceholder"), text: typedBinding)
                .textFieldStyle(.vision)
                .focused($searchFocused)
                .onSubmit(commit)
                .onKeyPress(.delete) {
                    removeLastTag() ? KeyPress.Result.handled : KeyPress.Result.ignored
                }
                // The field editor may take Backspace first; the delete command is the second path.
                .onDeleteCommand {
                    _ = removeLastTag()
                }
            if let createError {
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(strings.t("tags.createFailed"))
                        if !createError.isEmpty {
                            Text(createError)
                                .foregroundStyle(theme.secondaryLabel)
                        }
                    }
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                }
                .font(.footnote)
                .foregroundStyle(theme.destructive)
                .accessibilityElement(children: .combine)
            }
            if state.showsSlugHint {
                Text(strings.t("tags.slugifyHint").replacingOccurrences(of: "{{slug}}", with: state.liveSlug))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
            if suggestions.isEmpty && !canCreate {
                Text(strings.t("tags.empty"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            if !suggestions.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(suggestions, id: \.slug) { tag in
                            Button {
                                state.add(tag.slug)
                                state.typed = ""
                                onChange(state.selected)
                            } label: {
                                TagChip(slug: tag.slug, color: tag.color)
                                    .opacity(tag.isActive ? 1 : 0.4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 2)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 200)
                .fixedSize(horizontal: false, vertical: true)
            }
            if canCreate {
                Divider()
                HStack(spacing: 6) {
                    Button {
                        Task { await create(state.liveSlug) }
                    } label: {
                        Label(
                            strings.t("tags.create").replacingOccurrences(of: "'{{slug}}'", with: "'\(state.liveSlug)'"),
                            systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                    Spacer(minLength: 0)
                    ForEach(PickerDataModel.tagPalette, id: \.color) { swatch in
                        Button {
                            pendingColor = swatch.color
                        } label: {
                            Circle()
                                .fill(TagColor.color(swatch.color) ?? .gray)
                                .frame(width: 12, height: 12)
                                .overlay(
                                    Circle().strokeBorder(
                                        pendingColor == swatch.color ? theme.foreground : Color.clear, lineWidth: 2))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(strings.t(swatch.nameKey))
                        .accessibilityAddTraits(pendingColor == swatch.color ? .isSelected : [])
                    }
                }
            }
        }
        .padding(8)
        .frame(width: 320)
        .onAppear { searchFocused = true }
    }

    /// A comma commits like Return.
    private var typedBinding: Binding<String> {
        Binding(
            get: { state.typed },
            set: { text in
                if text.contains(",") {
                    state.typed = text.replacingOccurrences(of: ",", with: "")
                    commit()
                } else {
                    state.typed = text
                }
            })
    }

    /// Backspace in an empty field removes the last tag; with typed text it only edits the text.
    private func removeLastTag() -> Bool {
        guard state.typed.isEmpty, !state.selected.isEmpty else { return false }
        state.backspace()
        onChange(state.selected)
        return true
    }

    private func commit() {
        switch state.commit(existing: pickers.tags) {
        case .nothing:
            return
        case .added:
            onChange(state.selected)
        case .create(let slug):
            Task { await create(slug) }
        }
    }

    private func create(_ slug: String) async {
        guard state.canCreate(existing: pickers.tags) else { return }
        let failure = await pickers.createTag(slug: slug, color: pendingColor)
        createError = failure.map { APIErrorMessage.text($0, strings: strings) }
        state.add(slug)
        state.typed = ""
        pendingColor = PickerDataModel.tagPalette.randomElement()?.color ?? pendingColor
        onChange(state.selected)
    }
}
