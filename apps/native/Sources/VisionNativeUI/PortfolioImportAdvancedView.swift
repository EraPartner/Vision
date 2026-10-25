import SwiftUI
import VisionNativeCore

struct PortfolioImportAdvancedView: View {
    let model: PortfolioImportParserModel
    let shell: NativeShellModel
    var isLocked = false
    let onReviewHistory: () -> Void
    @State private var expanded = false
    @State private var deleting = false
    @State private var fileError = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private let sources: [(String, String)] = [
        ("auto", "portfolioImport.autoDetect"), ("custom", "portfolioImport.newCustom"),
        ("ibkr", "portfolioImport.ibkrParser"), ("ibkr_funding_history", "portfolioImport.ibkrFundingParser"),
        ("kinesis", "portfolioImport.kinesisParser"), ("nexo", "portfolioImport.nexoParser"),
        ("nexo_pro", "portfolioImport.nexoProParser"), ("saxo", "portfolioImport.saxoParser"),
    ]
    var body: some View {
        AdminCard {
            DisclosureGroup(strings.t("portfolioImport.session.advanced"), isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 20) {
                    PortfolioImportFileDropzone(
                        multiple: false, file: model.file, strings: strings,
                        isDisabled: model.isBusy || isLocked,
                        onFiles: { files in
                            fileError = false
                            await model.selectFile(files.first)
                        }, onUnreadable: { fileError = true }, remove: { Task { await model.selectFile(nil) } })
                    if fileError { Text(strings.t("portfolioImport.invalidFile")).foregroundStyle(theme.destructive) }
                    if model.file != nil && !model.config.isSpecialized {
                        PortfolioImportHeadersView(
                            headers: model.rawHeaders, rows: model.sampleRows,
                            config: model.config, strings: strings, isLoading: model.isDetecting,
                            error: model.probe?.previewError)
                    }
                    parserSource
                    if model.isDetecting {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(strings.t("portfolioImport.detecting"))
                        }
                        .foregroundStyle(theme.secondaryLabel)
                    }
                    if model.detectionFailed {
                        Text(strings.t("portfolioImport.detectionFailed")).foregroundStyle(theme.destructive)
                    }
                    if let key = model.config.specializedHintKey {
                        Text(strings.t(key)).font(.callout).foregroundStyle(theme.secondaryLabel)
                    } else {
                        if model.file == nil {
                            Text(strings.t("portfolioImport.chooseFileFirst")).foregroundStyle(theme.secondaryLabel)
                        }
                        PortfolioImportConfigFields(
                            config: Binding(get: { model.config }, set: { model.config = $0 }),
                            headers: model.rawHeaders, typeValues: model.typeValues, strings: strings,
                            showMappings: model.file != nil
                        )
                        .disabled(model.isBusy || isLocked)
                    }
                    broker
                    DisclosureGroup(strings.t("portfolioImport.saveParserOptions")) {
                        HStack(alignment: .bottom, spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(strings.t("importPage.customParser.name")).font(.callout.weight(.medium))
                                TextField(
                                    strings.t("importPage.customParser.name"),
                                    text: Binding(get: { model.parserName }, set: { model.parserName = $0 }),
                                    prompt: Text(strings.t("portfolioImport.parserNamePlaceholder"))
                                ).textFieldStyle(.vision)
                            }
                            Button(
                                strings.t(
                                    model.selectedParser == nil
                                        ? "importPage.customParser.save" : "importPage.customParser.saveChanges"),
                                systemImage: "square.and.arrow.down"
                            ) {
                                Task { await model.saveParser() }
                            }.buttonStyle(.visionOutline).disabled(!model.canSave || isLocked)
                            if model.selectedParser != nil {
                                Button(
                                    strings.t("importPage.customParser.delete"), systemImage: "trash",
                                    role: .destructive
                                ) { deleting = true }
                                .buttonStyle(.visionOutline).disabled(model.isBusy || isLocked)
                            }
                        }.padding(.top, 12).disabled(model.isBusy || isLocked)
                    }
                    if let progress = model.progress {
                        if model.isBusy {
                            PortfolioImportProgressView(progress: progress, strings: strings)
                        } else if progress.phase == "complete" {
                            Label(strings.t("importPage.complete"), systemImage: "checkmark.circle").foregroundStyle(
                                theme.success)
                        } else if progress.phase == "error" {
                            Label(strings.t("importPage.failed"), systemImage: "xmark.circle").foregroundStyle(
                                theme.destructive)
                        }
                    }
                    if let error = model.error {
                        Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                    }
                    if let notice = model.notice {
                        Text(
                            strings.t(
                                notice,
                                [
                                    "n": String(model.outcome?.imported ?? 0),
                                    "dups": String(model.outcome?.duplicates ?? 0),
                                ])
                        )
                        .foregroundStyle(
                            notice == "importPage.toast.importCancelled" ? theme.secondaryLabel : theme.success)
                    }
                    if let skipped = model.outcome?.skipped, skipped > 0 {
                        Text(strings.t("portfolioImport.toast.rowsSkipped", ["n": String(skipped)])).foregroundStyle(
                            theme.warning)
                    }
                    if model.outcomeUncertain {
                        Text(strings.t("portfolioImport.session.responseUnverified")).foregroundStyle(theme.warning)
                        Button(strings.t("portfolioImport.session.history.title"), action: onReviewHistory)
                            .buttonStyle(.visionOutline)
                        Button(strings.t("common.retry")) {
                            Task {
                                await model.recoverUncertainOutcome()
                            }
                        }.buttonStyle(.visionOutline).disabled(model.isBusy || isLocked)
                    }
                    HStack {
                        Spacer()
                        if model.isBusy {
                            Button(strings.t("importPage.cancelBtn")) { model.cancel() }.buttonStyle(.visionOutline)
                        }
                        Button(
                            strings.t(model.isBusy ? "importPage.importingBtn" : "importPage.importBtn"),
                            systemImage: "arrow.up.doc"
                        ) {
                            Task { await model.importFile() }
                        }.buttonStyle(.visionPrimary).disabled(!model.canImport || isLocked)
                    }
                }.padding(.top, 16)
            }
        }.visionAlert(
            title: strings.t("importPage.customParser.deleteTitle"),
            message: strings.t("importPage.customParser.deleteConfirm", ["name": model.selectedParser?.name ?? ""]),
            isPresented: $deleting
        ) {
            VisionDialogAction(strings.t("common.cancel"), role: .cancel)
            VisionDialogAction(strings.t("common.confirm"), role: .destructive) {
                Task { await model.deleteParser() }
            }
        }
    }
    private var parserSource: some View {
        let pairs: [(String, String)] =
            sources.map { ($0.0, strings.t($0.1)) } + model.savedParsers.map { ("saved:\($0.id.rawValue)", $0.name) }
        return VStack(alignment: .leading, spacing: 6) {
            Text(strings.t("portfolioImport.parserSource")).font(.callout.weight(.medium))
            VisionSelect(
                selection: Binding(
                    get: { model.source },
                    set: { value in
                        Task { await model.selectSource(value) }
                    }),
                options: VisionSelectOption<String>.pairs(pairs),
                accessibilityLabel: strings.t("portfolioImport.parserSource"), expands: true
            ).frame(maxWidth: 420).disabled(model.isBusy || isLocked)
        }
    }
    private var broker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t("addPortTxn.broker")).font(.callout.weight(.medium))
            VisionSelect(
                selection: Binding(get: { model.config.accountId }, set: { model.setAccount($0) }),
                options: [VisionSelectOption<AccountID?>(value: nil, title: strings.t("addPortTxn.broker.unassigned"))]
                    + model.brokerAccounts.map { VisionSelectOption<AccountID?>(value: $0.id, title: $0.name) },
                accessibilityLabel: strings.t("addPortTxn.broker"), expands: true
            ).frame(maxWidth: 420).disabled(model.isBusy || isLocked)
        }
    }
}
