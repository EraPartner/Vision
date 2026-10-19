import SwiftUI
import VisionNativeCore

public struct AnalysisWorkspaceView: View {
    let model: AnalysisWorkspaceModel
    let workbench: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @State private var templatesOpen = true
    @State private var builderOpen = true
    @State private var toolsOpen = false
    @State private var resultFocusRequest = 0
    @FocusState private var builderFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Environment(\.visionTheme) private var theme

    public init(model: AnalysisWorkspaceModel, workbench: AnalysisWorkbenchModel, shell: NativeShellModel) {
        self.model = model
        self.workbench = workbench
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }

    public var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: VisionPageLayout.spacing) {
                        VisionPageHeader(
                            title: strings.t("analysis.title"), subtitle: strings.t("analysis.subtitle"),
                            symbol: "tablecells")
                        workflow(proxy)
                        let wide = geometry.size.width >= 1140
                        let layout =
                            wide
                            ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
                            : AnyLayout(VStackLayout(alignment: .leading, spacing: 24))
                        layout {
                            VStack(alignment: .leading, spacing: 24) {
                                if model.dataset?.relation.hasPrefix("service:") == true { financialParameters }
                                templates(proxy)
                                query(proxy)
                                if model.displayedResult != nil {
                                    AnalysisResultView(model: model, shell: shell, focusRequest: resultFocusRequest)
                                }
                                if model.displayedResult != nil {
                                    AnalysisPanel {
                                        DisclosureGroup(strings.t("analysis.refineTitle"), isExpanded: $toolsOpen) {
                                            VStack(alignment: .leading, spacing: 12) {
                                                Text(strings.t("analysis.refineHelp")).font(.callout).foregroundStyle(
                                                    theme.secondaryLabel)
                                                AnalysisWorkbenchView(model: workbench, shell: shell)
                                            }.padding(.top, 12)
                                        }
                                    }
                                }
                                savedFeedback
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .leading, spacing: 24) {
                                AnalysisReusableView(model: model, shell: shell)
                                AnalysisSavedLibraryView(
                                    model: model, shell: shell,
                                    onSelect: {
                                        templatesOpen = false
                                        builderOpen = true
                                    })
                            }.frame(width: wide ? 360 : nil)
                        }
                    }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .task(id: String(shell.settingsRevision)) {
            if let screens = shell.analysis, screens.workspace === model, screens.workbench === workbench {
                screens.configure(settings: shell.settings)
                await screens.didAppear(route: shell.route)
            } else {
                model.configure(settings: shell.settings)
                await model.load(route: shell.route)
            }
        }
        .onDisappear {
            guard !shell.isTemporarilyCovered("/analysis") else { return }
            if let screens = shell.analysis, screens.workspace === model, screens.workbench === workbench {
                screens.didDisappear()
            } else {
                workbench.cancel()
            }
        }
        .onChange(of: model.selectedSaved?.id) { _, id in
            if id != nil {
                templatesOpen = false
                builderOpen = true
            }
        }
    }

    private func workflow(_ proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 10) {
            ForEach(["data", "prepare", "calculate", "present"], id: \.self) { section in
                Button(strings.t("analysis.workflow." + section)) {
                    if section == "prepare" || section == "calculate" { toolsOpen = true }
                    Task {
                        await Task.yield()
                        scroll(proxy, to: "analysis-" + section)
                    }
                }.buttonStyle(.visionOutline)
                    .disabled(section == "present" && model.displayedResult == nil)
            }
        }.accessibilityElement(children: .contain).accessibilityLabel(strings.t("analysis.workflow.title"))
    }

    private var financialParameters: some View {
        AnalysisPanel {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], alignment: .leading, spacing: 14
            ) {
                financialText("reportingCurrency", path: \.reportingCurrency)
                financialDate("from", path: \.from)
                financialDate("to", path: \.to)
                financialText("symbol", path: \.symbol)
                financialText("range", path: \.range)
                financialText("costBasisMethod", path: \.costBasisMethod)
            }
        }
    }
    private func financialText(_ key: String, path: WritableKeyPath<AnalysisPlan, String?>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t("analysis.ext.financial." + key)).font(.callout)
            TextField(
                "",
                text: Binding(
                    get: { model.plan[keyPath: path] ?? "" },
                    set: {
                        model.plan[keyPath: path] = $0.isEmpty ? nil : $0
                    })
            ).textFieldStyle(.roundedBorder).accessibilityLabel(strings.t("analysis.ext.financial." + key))
        }
    }
    private func financialDate(_ key: String, path: WritableKeyPath<AnalysisPlan, String?>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t("analysis.ext.financial." + key)).font(.callout)
            VisionDateField(
                day: PlannedDay(ymd: model.plan[keyPath: path], calendar: .current),
                placeholder: strings.t("analysis.ext.financial." + key), allowClear: true,
                settings: shell.settings, strings: strings, calendar: .current,
                onChange: { model.plan[keyPath: path] = $0?.ymd }
            )
            .accessibilityLabel(strings.t("analysis.ext.financial." + key))
        }
    }

    private func templates(_ proxy: ScrollViewProxy) -> some View {
        AnalysisPanel {
            DisclosureGroup(
                strings.t(templatesOpen ? "analysis.startTitle" : "analysis.chooseTemplate"), isExpanded: $templatesOpen
            ) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(strings.t("analysis.taskStartHelp"))
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: 560, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(AnalysisTemplate.all) { template in
                        Button {
                            model.applyTemplate(template, name: strings.t(template.titleKey))
                            templatesOpen = false
                            builderOpen = false
                            builderFocused = true
                            scroll(proxy, to: "analysis-data")
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(strings.t(template.titleKey)).font(.headline)
                                Text(strings.t(template.descriptionKey)).font(.footnote).foregroundStyle(
                                    theme.secondaryLabel)
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .visionCardBackground()
                    }
                    Button(strings.t("analysis.blank")) {
                        model.startBlank()
                        templatesOpen = false
                        builderOpen = true
                    }.buttonStyle(.visionOutline)
                }.padding(.top, 12)
            }
        }
    }

    private func query(_ proxy: ScrollViewProxy) -> some View {
        AnalysisPanel(title: strings.t("analysis.workflow.data"), description: strings.t("analysis.buildHelp")) {
            if !builderOpen, model.mode == .visual, let dataset = model.dataset { summary(dataset) }
            HStack {
                Button(strings.t(model.activeRequest == nil ? "analysis.run" : "analysis.running"), systemImage: "play")
                {
                    Task {
                        if await model.run(offset: 0) {
                            builderOpen = false
                            toolsOpen = false
                            resultFocusRequest += 1
                            await Task.yield()
                            scroll(proxy, to: "analysis-present")
                        } else {
                            builderOpen = true
                        }
                    }
                }.buttonStyle(.visionPrimary).disabled(model.activeRequest != nil)
                if model.activeRequest != nil {
                    ProgressView().controlSize(.small)
                    Button(strings.t("analysis.cancel"), systemImage: "stop", role: .destructive) {
                        Task { await model.cancel() }
                    }
                    .buttonStyle(.visionOutline)
                }
            }
            DisclosureGroup(isExpanded: $builderOpen) {
                AnalysisQueryBuilderView(model: model, shell: shell).padding(.top, 14)
            } label: {
                Text(strings.t("analysis.editConfiguration")).focusable().focused($builderFocused)
                    .onKeyPress(.return) {
                        builderOpen.toggle()
                        return .handled
                    }
                    .onKeyPress(.space) {
                        builderOpen.toggle()
                        return .handled
                    }
                    .accessibilityAction { builderOpen.toggle() }
            }
            if let error = model.error {
                Text(strings.t(error)).foregroundStyle(theme.destructive).textSelection(.enabled)
                if model.lastUsableResult != nil {
                    Text(strings.t("analysis.lastResultPreserved")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                }
            }
        }.id("analysis-data")
    }
    private func summary(_ dataset: AnalysisDataset) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), alignment: .leading)], alignment: .leading, spacing: 14) {
            summaryItem("analysis.dataset", value: AnalysisSourceLabels.catalog(dataset.label, strings: strings))
            summaryItem(
                "analysis.fields",
                value: model.plan.fields.map { id in
                    dataset.fields.first { $0.id == id }.map {
                        AnalysisSourceLabels.catalog($0.label ?? $0.id, strings: strings)
                    } ?? id
                }.joined(separator: ", "))
            summaryItem(
                "analysis.measures",
                value: model.plan.measures.map { id in
                    dataset.measures.first { $0.id == id }.map {
                        AnalysisSourceLabels.catalog($0.label ?? $0.id, strings: strings)
                    } ?? id
                }.joined(separator: ", "))
            summaryItem(
                "analysis.configurationScope",
                value: strings.t(
                    "analysis.configurationScopeValue",
                    ["filters": String(model.plan.filters.count), "limit": String(model.plan.limit)]))
        }
    }
    private func summaryItem(_ key: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(key)).font(.footnote).foregroundStyle(theme.secondaryLabel)
            Text(value.isEmpty ? "—" : value)
        }.accessibilityElement(children: .combine)
    }

    @ViewBuilder private var savedFeedback: some View {
        if model.savedAction || model.isSaving {
            HStack {
                ProgressView().controlSize(.small)
                Text(strings.t("analysis.savedActionWorking"))
            }
        } else if let feedback = model.savedFeedback {
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t(feedback.message)).foregroundStyle(feedback.error ? theme.destructive : theme.foreground)
                if feedback.error {
                    Button(strings.t("analysis.savedActionRetry")) { Task { await model.loadSavedList() } }.buttonStyle(.visionOutline)
                }
            }
        }
    }
    private func scroll(_ proxy: ScrollViewProxy, to id: String) {
        if reducedMotion {
            proxy.scrollTo(id, anchor: .top)
        } else {
            withAnimation { proxy.scrollTo(id, anchor: .top) }
        }
    }
}
