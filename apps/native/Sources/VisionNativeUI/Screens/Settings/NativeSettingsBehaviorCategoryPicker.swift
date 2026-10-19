import SwiftUI
import VisionNativeCore

struct NativeSettingsBehaviorCategoryPicker: View {
    let categories: [OpenAPI.CategoryNode]
    let value: Int?
    let disabled: Bool
    let label: String
    let strings: any Localizing
    let select: (Int?) -> Void
    @State private var isOpen = false
    @State private var search = ""
    @State private var activeIndex = 0
    @FocusState private var searchFocused: Bool
    @Environment(\.visionTheme) private var theme
    private struct Choice: Identifiable {
        let id: String
        let categoryID: Int?
        let title: String
    }
    private var choices: [Choice] {
        var items: [Choice] = []
        if search.isEmpty || "__none__".contains(search.lowercased()) {
            items.append(.init(id: "none", categoryID: nil, title: strings.t("combobox.category.none")))
        }
        items += NativeSettingsBehaviorCategoryQuery.matching(categories, search: search).map {
            .init(id: String($0.id), categoryID: $0.id, title: $0.path.joined(separator: " / "))
        }
        return items
    }
    var body: some View {
        PickerButton(
            label: NativeSettingsBehaviorCategoryQuery.label(value, categories: categories),
            placeholder: strings.t("combobox.category.placeholder"), disabled: disabled, isOpen: $isOpen
        ) {
            VStack(alignment: .leading, spacing: 6) {
                TextField(strings.t("combobox.category.search"), text: $search).textFieldStyle(.vision)
                    .focused($searchFocused).onSubmit {
                        if choices.indices.contains(activeIndex) { pick(choices[activeIndex]) }
                    }
                    .onKeyPress(.downArrow) { move(1) }.onKeyPress(.upArrow) { move(-1) }
                    .onExitCommand { isOpen = false }
                if choices.isEmpty {
                    Text(strings.t("combobox.category.empty")).font(.callout).foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity).padding(12)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                                    Button {
                                        pick(choice)
                                    } label: {
                                        HStack(spacing: 8) {
                                            Image(systemName: "checkmark").opacity(value == choice.categoryID ? 1 : 0)
                                                .accessibilityHidden(true)
                                            Text(verbatim: choice.title).italic(choice.categoryID == nil)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }.font(.callout).padding(.horizontal, 8).padding(.vertical, 7)
                                            .contentShape(Rectangle()).background(
                                                index == activeIndex ? theme.primary.opacity(0.12) : .clear,
                                                in: RoundedRectangle(cornerRadius: 6))
                                    }.buttonStyle(.plain).id(choice.id).onHover { if $0 { activeIndex = index } }
                                }
                            }
                        }.frame(maxHeight: 280).fixedSize(horizontal: false, vertical: true)
                            .onChange(of: activeIndex) { _, index in
                                if choices.indices.contains(index) { proxy.scrollTo(choices[index].id) }
                            }
                    }
                }
            }.padding(8).frame(width: 280).onAppear { searchFocused = true }
        }.accessibilityLabel(label)
            .onChange(of: search) { _, _ in activeIndex = 0 }
            .onChange(of: isOpen) { _, open in
                if !open {
                    search = ""
                    activeIndex = 0
                }
            }
    }
    private func pick(_ choice: Choice) {
        select(choice.categoryID)
        isOpen = false
    }
    private func move(_ offset: Int) -> KeyPress.Result {
        guard !choices.isEmpty else { return .ignored }
        activeIndex = min(choices.count - 1, max(0, activeIndex + offset))
        return .handled
    }
}
