import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore

/// Statement bytes are read for the current import only; session checkpoints keep metadata.
struct PortfolioImportFileDropzone: View {
    let multiple: Bool
    var file: PortfolioImportFile? = nil
    let strings: any Localizing
    var isDisabled = false
    var maximumFiles = 100
    let onFiles: ([PortfolioImportFile]) async -> Void
    let onUnreadable: () -> Void
    var onTooMany: (() -> Void)? = nil
    var remove: (() -> Void)? = nil
    @State private var picker = false
    @State private var targeted = false
    @State private var reading = false
    @Environment(\.visionTheme) private var theme
    private var contentTypes: [UTType] {
        [.commaSeparatedText] + ["xlsx", "xls"].compactMap { UTType(filenameExtension: $0) }
    }
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: file == nil ? "icloud.and.arrow.up" : "doc")
                .font(.system(size: 34)).foregroundStyle(file == nil ? theme.tertiaryLabel : theme.primary)
                .accessibilityHidden(true)
            if let file {
                Text(verbatim: file.filename).font(.body.weight(.medium)).lineLimit(1).truncationMode(.middle)
                Text("\(Int((Double(file.data.count) / 1024).rounded())) \(strings.t("common.kb"))")
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                if let remove {
                    Button(strings.t("importPage.remove"), systemImage: "trash", role: .destructive, action: remove)
                        .buttonStyle(.vision(.ghost, size: .sm))
                }
            } else {
                Text(strings.t(multiple ? "portfolioImport.session.files" : "portfolioImport.dropzone"))
                    .font(.body.weight(.medium))
                // The session dropzone shows only its label; the single-file one adds the hint.
                if !multiple {
                    Text(strings.t("importPage.dropzoneOr")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
            }
            if reading { ProgressView().controlSize(.small) }
        }.frame(maxWidth: .infinity).padding(multiple ? 40 : 32)
            .background(
                targeted ? theme.primary.opacity(0.05) : .clear,
                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card).strokeBorder(
                    targeted ? theme.primary : theme.border.opacity(multiple ? 0.6 : 1),
                    style: StrokeStyle(lineWidth: multiple ? 1 : 2, dash: [6, 4]))
            )
            .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .onTapGesture { if !isDisabled && !reading { picker = true } }
            .focusable().onKeyPress(keys: [.return, .space]) { _ in
                guard !isDisabled && !reading else { return .ignored }
                picker = true
                return .handled
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(strings.t(multiple ? "portfolioImport.session.files" : "portfolioImport.chooseFile"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if !isDisabled && !reading { picker = true } }
            .dropDestination(for: URL.self) { urls, _ in
                guard !isDisabled && !reading, !urls.isEmpty, urls.allSatisfy(\.isFileURL) else { return false }
                Task { await read(multiple ? urls : Array(urls.prefix(1))) }
                return true
            } isTargeted: {
                targeted = $0
            }
            .fileImporter(isPresented: $picker, allowedContentTypes: contentTypes, allowsMultipleSelection: multiple) {
                result in
                if case .success(let urls) = result { Task { await read(urls) } }
            }
            .disabled(isDisabled || reading)
    }
    private func read(_ urls: [URL]) async {
        guard !isDisabled, !reading else { return }
        guard urls.count <= maximumFiles else {
            if let onTooMany { onTooMany() } else { onUnreadable() }
            return
        }
        reading = true
        defer { reading = false }
        var files: [PortfolioImportFile] = []
        for url in urls {
            guard ["csv", "xlsx", "xls"].contains(url.pathExtension.lowercased()) else {
                onUnreadable()
                continue
            }
            guard let file = await PortfolioImportFile.read(url) else {
                onUnreadable()
                continue
            }
            files.append(file)
        }
        if !files.isEmpty { await onFiles(files) }
    }
}

struct PortfolioImportProgressView: View {
    let progress: ImportProgress
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if progress.phase == "complete" {
                    Image(systemName: "checkmark.circle").foregroundStyle(theme.success)
                } else if progress.phase == "error" {
                    Image(systemName: "xmark.circle").foregroundStyle(theme.destructive)
                } else {
                    ProgressView().controlSize(.small)
                }
                Text(progress.labelKey.map { strings.t($0) } ?? progress.phase.capitalized)
                Spacer()
                Text("\(Int(progress.percent))%").monospacedDigit()
            }
            ProgressView(value: progress.fraction)
                .accessibilityValue("\(Int(progress.percent))%")
        }.accessibilityElement(children: .combine).padding(.vertical, 8)
    }
}
