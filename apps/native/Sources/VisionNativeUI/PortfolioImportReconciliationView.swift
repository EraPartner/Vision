import SwiftUI
import VisionNativeCore

/// Renders validated backend evidence; financial decisions and amounts remain server-owned.
public struct PortfolioImportReconciliationView: View {
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    @State private var evidenceExpanded = false
    @Environment(\.visionTheme) private var theme
    public init(model: PortfolioImportSessionModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let plan = model.plan { review(plan) }
            if model.operation == .commit {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(strings.t("portfolioImport.session.committing"))
                }
            }
            if let result = model.result {
                Text(outcome(result)).accessibilityAddTraits(.updatesFrequently)
                    .onAppear { AccessibilityNotification.Announcement(outcome(result)).post() }
            }
        }
    }
    private func review(_ plan: PortfolioImportReconciliationPlan) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(strings.t("portfolioImport.session.review")).font(.headline)
            LazyVGrid(
                columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], alignment: .leading
            ) {
                ForEach(Self.actions.filter { (plan.summary[$0] ?? 0) > 0 }, id: \.self) { action in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("portfolioImport.session.actions.\(action)")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                        Text(verbatim: String(plan.summary[action] ?? 0)).font(.title3).monospacedDigit()
                    }
                }
            }
            if !plan.blockers.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(strings.t("portfolioImport.session.blocked")).font(.callout.weight(.medium))
                        .foregroundStyle(theme.destructive)
                    ForEach(Array(plan.blockers.enumerated()), id: \.offset) { _, blocker in
                        blockerRow(blocker)
                    }
                }.accessibilityElement(children: .contain)
            }
            DisclosureGroup(strings.t("portfolioImport.session.evidence"), isExpanded: $evidenceExpanded) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(plan.actions.prefix(model.shownActions))) { action in
                        PortfolioImportEvidenceView(action: action, model: model, shell: shell)
                    }
                    if plan.actions.count > model.shownActions {
                        Button(strings.t("portfolioImport.session.more")) { model.shownActions += 50 }
                            .buttonStyle(.visionOutline)
                    }
                }.padding(.top, 12)
            }
            Text(strings.t("portfolioImport.session.atomic")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Button(strings.t("portfolioImport.session.commit")) { Task { await model.commit() } }
                .buttonStyle(.visionPrimary).disabled(!model.canCommit || model.operation != .idle)
        }.padding(16).background(
            theme.foreground.opacity(0.03), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
        )
        .accessibilityElement(children: .contain).accessibilityLabel(strings.t("portfolioImport.session.review"))
    }
    /// One blocked row. The owner settles a look-alike of an existing transaction with "Keep both", or
    /// with "Same transaction" when it names a single counterpart; the answer re-runs the review.
    private func blockerRow(_ blocker: PortfolioImportReconciliationBlocker) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(blockerText(blocker)).font(.caption).foregroundStyle(theme.destructive)
            if let rowId = blocker.rowId, PortfolioImportSessionModel.choosableBlockers.contains(blocker.reason) {
                HStack(spacing: 8) {
                    choiceButton("portfolioImport.session.choice.keepBoth", blocker.batchId, rowId, .keepBoth)
                    if PortfolioImportSessionModel.sameTransactionBlockers.contains(blocker.reason),
                        blocker.candidateTransactionIds.count <= 1
                    {
                        choiceButton(
                            "portfolioImport.session.choice.sameTransaction", blocker.batchId, rowId, .sameTransaction)
                    }
                }
            }
        }
    }
    private func choiceButton(
        _ key: String, _ batchId: PortfolioImportBatchNumericID, _ rowId: PortfolioImportRowID,
        _ choice: PortfolioImportRowChoice.Choice
    ) -> some View {
        Button(strings.t(key)) { Task { await model.choose(batchId: batchId, rowId: rowId, choice: choice) } }
            .buttonStyle(.visionOutline).controlSize(.small).disabled(model.operation != .idle)
    }
    private func blockerText(_ blocker: PortfolioImportReconciliationBlocker) -> String {
        let row = blocker.rowOrdinal.map { " · " + strings.t("portfolioImport.session.row", ["n": String($0)]) } ?? ""
        let reason = strings.t("portfolioImport.session.blockers.\(Self.blockerKeys[blocker.reason] ?? "other")")
        return "\(statementName(blocker.batchId))\(row): \(reason)"
    }
    private func statementName(_ id: PortfolioImportBatchNumericID) -> String {
        model.statements.first { $0.batchId == id }?.name ?? String(id.rawValue)
    }
    private func outcome(_ result: PortfolioImportReconciliationResult) -> String {
        strings.t(
            "portfolioImport.session.success",
            [
                "imported": String(result.imported), "adopted": String(result.adopted),
                "duplicates": String(result.duplicates),
            ])
    }
    static let actions = [
        "insert", "adopt", "duplicate", "duplicate_source", "cash", "transfer", "internal_annotation", "adjustment",
        "settled", "blocked", "policy_required",
    ]
    private static let blockerKeys = [
        "incomplete_source": "incomplete", "invalid_source_values": "invalid", "source_identity_conflict": "identity",
        "missing_original_basis": "basis", "ambiguous_history": "ambiguous",
        "existing_assigned_or_imported_history": "assigned", "missing_source_identity": "identity",
        "source_policy_required": "policy", "unproven_currency_conversion": "currency",
        "unproven_economics": "economics", "missing_companion_pro_history": "companionPro",
        "unresolved_adjustment_kind": "adjustmentKind", "unresolved_adjustment_basis": "adjustmentBasis",
        "incomplete_adjustment": "adjustmentIncomplete", "missing_adjustment_identity": "identity",
        "unresolved_zero_yield_policy": "zeroYield", "projected_history_conflict": "projectedHistory",
        "cross_format_source_conflict": "crossFormat", "cross_format_identity_missing": "crossFormatIdentity",
        "cross_format_identity_ambiguous": "crossFormatIdentityAmbiguous",
        "funding_date_mismatch": "fundingDateMismatch", "funding_date_ambiguous": "fundingDateAmbiguous",
        "ambiguous_funding_history": "ambiguousFunding", "ambiguous_cash_history": "ambiguousCash",
    ]
}

private struct PortfolioImportEvidenceView: View {
    let action: PortfolioImportReconciliationAction
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private static let fields = [
        "date", "type", "units", "price_per_unit", "amount", "fees", "taxes", "currency", "fx_rate_to_eur",
        "dividend_amount_convention", "income_recognition_role",
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(
                "\(model.statements.first { $0.batchId == action.batchId }?.name ?? String(action.batchId.rawValue)) · \(strings.t("portfolioImport.session.row", ["n": String(action.rowOrdinal)])) · \(strings.t("portfolioImport.session.actions.\(PortfolioImportReconciliationView.actions.contains(action.action) ? action.action : "other")"))"
            )
            .font(.callout.weight(.medium))
            if let id = action.existingTransactionId { note("existingId", ["id": String(id.rawValue)]) }
            if let policy = action.policy {
                note("appliedPolicy", ["policy": strings.t("portfolioImport.session.policyName.\(policy)")])
            }
            if action.action == "internal_annotation" { note("annotationHint") }
            if let transfer = action.transfer { transferValues(transfer) }
            if let adjustment = action.adjustment { adjustmentValues(adjustment) }
            if action.source != nil { comparison }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.background.opacity(0.5), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(theme.border))
            .textSelection(.enabled)
    }
    private func note(_ key: String, _ variables: [String: String] = [:]) -> some View {
        Text(strings.t("portfolioImport.session.\(key)", variables)).font(.caption).foregroundStyle(
            theme.secondaryLabel)
    }
    private func account(_ value: TaxValue?) -> String {
        guard let id = value?.decimalValue else { return "—" }
        return model.accounts.first { Decimal($0.id.rawValue) == id }.map { $0.displayName ?? $0.name }
            ?? strings.t("portfolioImport.session.accountId", ["id": NSDecimalNumber(decimal: id).stringValue])
    }
    private func detail(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(strings.t("portfolioImport.session.\(key)")).foregroundStyle(theme.secondaryLabel)
            Spacer()
            Text(verbatim: value).monospacedDigit()
        }.font(.caption)
    }
    private func transferValues(_ values: TaxValue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            detail("fields.date", display(values["date"]))
            detail("transferSource", account(values["sourceAccountId"]))
            detail("transferDestination", account(values["destinationAccountId"]))
            detail("grossDebit", display(values["units"]))
            detail("transferFee", display(values["feeUnits"]))
            detail("netReceived", display(values["receivedUnits"]))
        }
    }
    private func adjustmentValues(_ values: TaxValue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            detail("fields.date", display(values["date"]))
            detail("adjustment.account", account(values["accountId"]))
            detail("fields.units", display(values["units"]))
            detail("adjustment.kind", labelled("adjustment.kind", display(values["kind"])))
            detail("adjustment.basis", labelled("adjustment.basis", display(values["basisPolicy"])))
        }
    }
    /// The fields either side holds a value for, as the web table lists them.
    private var fields: [String] {
        Self.fields.filter { nonnull(action.source?[$0]) || nonnull(action.existing?[$0]) }
    }
    private var comparison: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    Text(strings.t("portfolioImport.session.field"))
                    Text(strings.t("portfolioImport.session.sourceValues"))
                    if action.existing != nil { Text(strings.t("portfolioImport.session.existingValues")) }
                }.fontWeight(.medium)
                ForEach(fields, id: \.self) { field in
                    GridRow {
                        Text(strings.t("portfolioImport.session.fields.\(field)"))
                        Text(verbatim: display(action.source?[field], field: field))
                        if action.existing != nil { Text(verbatim: display(action.existing?[field], field: field)) }
                    }.padding(.vertical, 3).background(
                        (action.corrections?.contains(field) ?? false) ? theme.foreground.opacity(0.06) : .clear)
                }
            }.font(.caption).monospacedDigit()
        }
    }
    private func nonnull(_ value: TaxValue?) -> Bool { value != nil && value != .null }
    /// `portfolioImport.session.<group>.<value>`, or the value itself (including the "—"
    /// placeholder) when this build has no label for it.
    private func labelled(_ group: String, _ value: String) -> String {
        let key = "portfolioImport.session.\(group).\(value)"
        let text = strings.t(key)
        return text == key ? value : text
    }
    private func display(_ value: TaxValue?, field: String = "") -> String {
        guard let value, value != .null else { return "—" }
        if field == "dividend_amount_convention", let raw = value.stringValue {
            return strings.t("portfolioImport.session.convention.\(raw)")
        }
        if field == "income_recognition_role", let raw = value.stringValue {
            return strings.t("portfolio.incomeRole.\(raw)")
        }
        switch value {
        case .string(let raw): return raw
        case .number(let raw): return NSDecimalNumber(decimal: raw).stringValue
        case .bool(let raw): return String(raw)
        default: return "—"
        }
    }
}
