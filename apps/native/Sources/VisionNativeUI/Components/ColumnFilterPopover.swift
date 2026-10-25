import SwiftUI
import VisionNativeCore

/// `ColumnFilter` (apps/frontend/src/components/shared/ColumnFilter.tsx): the filter text,
/// a value search above more than eight values, up to 30 distinct values and Clear. Return
/// closes keeping the filter; Escape clears it and closes.
struct ColumnFilterPopover: View {
    let header: String
    @Binding var value: String
    let uniqueValues: [String]
    let strings: any Localizing
    let close: () -> Void
    @State private var valueSearch = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.visionTheme) private var theme

    init(
        header: String, value: Binding<String>, uniqueValues: [String], strings: any Localizing,
        close: @escaping () -> Void
    ) {
        self.header = header
        _value = value
        self.uniqueValues = uniqueValues
        self.strings = strings
        self.close = close
    }

    /// The list shows only for 1 to 100 distinct values.
    static let listLimit = 100
    /// At most this many value buttons.
    static let shownValues = 30
    /// The value search appears above this many values.
    static let searchThreshold = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("table.filterLabel", ["header": header]))
                .font(.footnote.weight(.medium))
                .foregroundStyle(theme.secondaryLabel)
            TextField(strings.t("table.filterInputPlaceholder", ["header": header.lowercased()]), text: $value)
                .textFieldStyle(.vision)
                .focused($inputFocused)
                .onSubmit(close)
                // The field editor takes Escape as `cancelOperation:` before `.onKeyPress` sees it.
                .onExitCommand {
                    value = ""
                    close()
                }
            if !uniqueValues.isEmpty && uniqueValues.count <= Self.listLimit {
                if uniqueValues.count > Self.searchThreshold {
                    TextField(strings.t("table.searchValues"), text: $valueSearch)
                        .textFieldStyle(.vision)
                        .font(.footnote)
                }
                valueList(LocalTableQuery.matchingValues(uniqueValues, search: valueSearch))
            }
            if !value.isEmpty {
                Button(strings.t("table.clearFilter")) {
                    value = ""
                    close()
                }
                .buttonStyle(.borderless)
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(10)
        .frame(width: 240)
        .onAppear { inputFocused = true }
    }

    @ViewBuilder
    private func valueList(_ matching: [String]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(matching.prefix(Self.shownValues)), id: \.self) { candidate in
                    let selected = value == candidate
                    Button {
                        value = candidate
                        close()
                    } label: {
                        Text(candidate)
                            .font(.footnote.weight(selected ? .medium : .regular))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? theme.primary : theme.foreground)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                            .fill(selected ? theme.primary.opacity(0.1) : Color.clear))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .frame(maxHeight: 160)
        .fixedSize(horizontal: false, vertical: true)
        if matching.count > Self.shownValues {
            Text(strings.t("table.moreValues", ["count": String(matching.count - Self.shownValues)]))
                .font(.caption)
                .foregroundStyle(theme.secondaryLabel)
                .padding(.horizontal, 8)
        }
    }
}
