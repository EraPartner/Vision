import SwiftUI
import VisionNativeCore

/// `TagFilterCombobox` (`MultiCombobox`): the closed face says Tags or "{n} selected"; the
/// popover searches the active tags and toggles each one, staying open.
struct TagMultiSelect: View {
    let pickers: PickerDataModel
    let selected: [String]
    var disabled = false
    let strings: any Localizing
    let onChange: ([String]) -> Void
    @State private var isOpen = false
    @State private var search = ""

    /// The trigger: `filter.tags.label`, or `combobox.tags.nSelected`.
    private var label: String {
        selected.isEmpty
            ? strings.t("filter.tags.label") : strings.t("combobox.tags.nSelected", ["n": String(selected.count)])
    }

    var body: some View {
        PickerButton(label: label, placeholder: label, disabled: disabled, isOpen: $isOpen) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("combobox.tags.search"),
                emptyText: strings.t("combobox.tags.empty"), options: options)
        }
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }

    private var options: [PickerOption] {
        pickers.tags(matching: search).map { tag in
            PickerOption(id: tag.slug, title: tag.slug, isSelected: selected.contains(tag.slug)) {
                onChange(PickerDataModel.toggling(tag.slug, in: selected))
            }
        }
    }
}
