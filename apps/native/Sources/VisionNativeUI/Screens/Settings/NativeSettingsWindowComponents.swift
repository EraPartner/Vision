import SwiftUI
import VisionNativeCore

struct NativeSettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 22, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain).accessibilityLabel(title)
    }
}

struct NativeSettingsGroup<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || description != nil {
                VStack(alignment: .leading, spacing: 4) {
                    if let title { Text(title).font(.caption.weight(.semibold)).accessibilityAddTraits(.isHeader) }
                    if let description { Text(description).font(.caption).foregroundStyle(theme.secondaryLabel) }
                }.padding(16).padding(.bottom, -4)
            }
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.card, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.border.opacity(0.6)))
    }
}

struct NativeSettingsRow<Content: View>: View {
    let title: String
    var description: String? = nil
    var stacked = false
    var destructive = false
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    private var label: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.body).foregroundStyle(destructive ? theme.destructive : theme.foreground)
            if let description {
                Text(description).font(.caption).foregroundStyle(theme.secondaryLabel).fixedSize(
                    horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    var body: some View {
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: 10) {
                    label
                    content()
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: 20) {
                        label.frame(minWidth: 145)
                        content().frame(minWidth: 100, maxWidth: 230, alignment: .trailing)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        label
                        content()
                    }
                }
            }
        }.padding(.horizontal, 16).padding(.vertical, 13)
    }
}

struct NativeSettingsOption: Identifiable {
    let value: String
    let label: String
    var id: String { value }
    init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

struct NativeSettingsSelectRow: View {
    let title: String
    var description: String? = nil
    @Binding var value: String
    let options: [NativeSettingsOption]
    var body: some View {
        NativeSettingsRow(title: title, description: description) {
            Picker(title, selection: $value) {
                ForEach(options) { Text($0.label).tag($0.value) }
            }.labelsHidden().accessibilityLabel(title)
        }
    }
}
