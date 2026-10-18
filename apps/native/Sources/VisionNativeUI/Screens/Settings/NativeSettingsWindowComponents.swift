import SwiftUI
import VisionNativeCore

struct NativeSettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 24, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain).accessibilityLabel(title)
    }
}

struct NativeSettingsGroup<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    init(title: String? = nil, description: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.description = description
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || description != nil {
                VStack(alignment: .leading, spacing: 4) {
                    if let title {
                        Text(title).font(.body.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if let description { Text(description).font(.footnote).foregroundStyle(theme.secondaryLabel) }
                }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 8)
            }
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
}

struct NativeSettingsRow<Content: View>: View {
    let title: String
    var description: String? = nil
    var stacked = false
    var destructive = false
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    init(
        title: String, description: String? = nil, stacked: Bool = false, destructive: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.description = description
        self.stacked = stacked
        self.destructive = destructive
        self.content = content
    }
    private var label: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.body).foregroundStyle(destructive ? theme.destructive : theme.foreground)
            if let description {
                Text(description).font(.footnote).foregroundStyle(theme.secondaryLabel).fixedSize(
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
    init(title: String, description: String? = nil, value: Binding<String>, options: [NativeSettingsOption]) {
        self.title = title
        self.description = description
        _value = value
        self.options = options
    }
    var body: some View {
        NativeSettingsRow(title: title, description: description) {
            Picker(title, selection: $value) {
                ForEach(options) { Text($0.label).tag($0.value) }
            }.labelsHidden().accessibilityLabel(title)
        }
    }
}
