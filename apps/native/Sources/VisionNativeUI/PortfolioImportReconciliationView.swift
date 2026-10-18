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
            if model.operation == "commit" {
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
            if model.existingOnly {
                Text(
                    strings.t(
                        "portfolioImport.session.\(modeKey("Counts"))",
                        [
                            "adopted": String(plan.summary["adopt"] ?? 0), "events": String(plan.summary["cash"] ?? 0),
                            "recorded": String(recorded(plan)), "pending": String(plan.pending ?? 0),
                        ]))
            }
            if model.reconciliationMode == .correctExistingOnly, plan.actions.contains(where: { $0.dateProof != nil }) {
                Text(strings.t("portfolioImport.session.groupDateCorrection")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
            if (plan.pending ?? 0) > 0 {
                Text(strings.t("portfolioImport.session.deferred")).font(.callout)
                ForEach((plan.deferredCounts ?? [:]).keys.sorted(), id: \.self) { reason in
                    if let count = plan.deferredCounts?[reason], count > 0 {
                        Text(
                            "\(strings.t("portfolioImport.session.deferredKinds.\(Self.deferredKinds.contains(reason) ? reason : "unsupported")")): \(count)"
                        )
                        .font(.caption)
                    }
                }
            }
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
                VStack(alignment: .leading, spacing: 8) {
                    Text(strings.t("portfolioImport.session.blocked")).font(.callout.weight(.medium))
                    ForEach(Array(plan.blockers.enumerated()), id: \.offset) { _, blocker in
                        Text(
                            "\(statementName(blocker.batchId))\(blocker.rowOrdinal.map { " · " + strings.t("portfolioImport.session.row", ["n": String($0)]) } ?? ""): \(strings.t("portfolioImport.session.blockers.\(Self.blockerKeys[blocker.reason] ?? "other")"))"
                        )
                        .font(.caption)
                    }
                }.foregroundStyle(theme.destructive).accessibilityElement(children: .contain)
            }
            DisclosureGroup(strings.t("portfolioImport.session.evidence"), isExpanded: $evidenceExpanded) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(plan.actions.prefix(model.shownActions))) { action in
                        PortfolioImportEvidenceView(action: action, model: model, shell: shell)
                    }
                    if plan.actions.count > model.shownActions {
                        Button(strings.t("portfolioImport.session.more")) { model.shownActions += 50 }
                    }
                }.padding(.top, 12)
            }
            Text(strings.t("portfolioImport.session.\(modeKey("Atomic"))")).font(.caption).foregroundStyle(
                theme.secondaryLabel)
            Button(strings.t("portfolioImport.session.\(commitKey)")) { Task { await model.commit() } }
                .buttonStyle(.borderedProminent).disabled(!model.canCommit || model.operation != "idle")
        }.padding(16).background(
            theme.foreground.opacity(0.03), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
        )
        .accessibilityElement(children: .contain).accessibilityLabel(strings.t("portfolioImport.session.review"))
    }
    private func recorded(_ plan: PortfolioImportReconciliationPlan) -> Int {
        if model.reconciliationMode != .recordCashOnly { return plan.summary["record_income"] ?? 0 }
        return plan.actions.filter { $0.action == "cash" }.reduce(0) {
            $0 + Int(NSDecimalNumber(decimal: $1.cashProof?["componentCount"]?.decimalValue ?? 0).intValue)
        }
    }
    private func modeKey(_ suffix: String) -> String {
        switch model.reconciliationMode {
        case .recordCashOnly: return "cash\(suffix)"
        case .recordInKindIncomeOnly: return "income\(suffix)"
        case .correctExistingOnly: return "correction\(suffix)"
        case .adoptExistingOnly: return "attachment\(suffix)"
        case .full: return suffix.lowercased()
        }
    }
    private var commitKey: String {
        switch model.reconciliationMode {
        case .recordCashOnly: return "recordReviewedCash"
        case .recordInKindIncomeOnly: return "recordReviewedIncome"
        case .correctExistingOnly: return "correctReviewed"
        case .adoptExistingOnly: return "attachReviewed"
        case .full: return "commit"
        }
    }
    private func statementName(_ id: Int) -> String { model.statements.first { $0.batchId == id }?.name ?? String(id) }
    private func outcome(_ result: PortfolioImportReconciliationResult) -> String {
        let partial = result.complete == false
        let key: String
        switch result.reconciliationScope ?? .full {
        case .recordCashOnly: key = partial ? "cashPartialSuccess" : "cashSuccess"
        case .recordInKindIncomeOnly: key = partial ? "incomePartialSuccess" : "incomeSuccess"
        default: key = partial ? "partialSuccess" : "success"
        }
        return strings.t(
            "portfolioImport.session.\(key)",
            [
                "imported": String(result.imported), "adopted": String(result.adopted),
                "repaired": String(result.repaired),
                "pending": String(result.pending ?? 0), "recordedIncome": String(result.recordedIncome ?? 0),
                "recordedCash": String(result.recordedCash ?? 0),
                "duplicates": String(max(0, result.duplicates - result.adopted - result.repaired)),
            ])
    }
    static let actions = [
        "record_income", "insert", "adopt", "repair_duplicate", "duplicate", "duplicate_source", "cash",
        "transfer", "internal_annotation", "adjustment", "settled", "blocked", "policy_required",
    ]
    private static let deferredKinds = ["dividend", "gift", "sell", "cash", "asset_transfer", "asset_adjustment"]
    private static let blockerKeys = [
        "incomplete_source": "incomplete", "invalid_source_values": "invalid", "source_identity_conflict": "identity",
        "missing_original_basis": "basis", "reference_unproven_basis": "basis", "ambiguous_history": "ambiguous",
        "existing_assigned_or_imported_history": "assigned", "missing_source_identity": "identity",
        "missing_adjustment_identity": "identity",
        "source_policy_required": "policy", "unproven_currency_conversion": "currency",
        "unproven_economics": "economics",
        "missing_companion_pro_history": "companionPro", "reference_ambiguous_asset": "referenceAsset",
        "reference_ambiguous_match": "referenceMatch", "reference_account_mapping_conflict": "referenceAccount",
        "reference_unmatched_event": "referenceEvent", "reference_unmapped_portfolio": "referencePortfolio",
        "reference_unproven_transfer_fee": "referenceFee", "reference_existing_trade_conflict": "referenceTrade",
        "unresolved_adjustment_kind": "adjustmentKind", "unresolved_adjustment_basis": "adjustmentBasis",
        "incomplete_adjustment": "adjustmentIncomplete", "unresolved_zero_yield_policy": "zeroYield",
        "projected_history_conflict": "projectedHistory", "cash_reconciliation_required": "cashScope",
    ]
}

private struct PortfolioImportEvidenceView: View {
    let action: PortfolioImportReconciliationAction
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(
                "\(model.statements.first { $0.batchId == action.batchId }?.name ?? String(action.batchId)) · \(strings.t("portfolioImport.session.row", ["n": String(action.rowOrdinal)])) · \(strings.t("portfolioImport.session.actions.\(PortfolioImportReconciliationView.actions.contains(action.action) ? action.action : "other")"))"
            )
            .font(.callout.weight(.medium))
            if let id = action.existingTransactionId { note("existingId", ["id": String(id)]) }
            if let proof = action.cashProof, let kind = proof["eventKind"]?.stringValue { note("cashKinds.\(kind)") }
            if let values = action.cashValues { cashValues(values) }
            if let fee = action.cashFeeValues {
                note("cashFeeExpense", ["amount": display(fee["amount"]), "currency": display(fee["currency"])])
            }
            if let id = action.existingCashFeeTransactionId { note("cashFeeExistingId", ["id": String(id)]) }
            if action.action == "repair_duplicate" {
                note(
                    "repairHint",
                    [
                        "existing": String(action.existingTransactionId ?? 0),
                        "imported": String(action.importedTransactionId ?? 0),
                        "batch": String(action.originalBatchId ?? 0),
                    ])
            }
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
        return model.accounts.first { Decimal($0.id) == id }.map { $0.displayName ?? $0.name }
            ?? strings.t("portfolioImport.session.accountId", ["id": NSDecimalNumber(decimal: id).stringValue])
    }
    private func detail(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(strings.t("portfolioImport.session.\(key)")).foregroundStyle(theme.secondaryLabel)
            Spacer()
            Text(verbatim: value).monospacedDigit()
        }.font(.caption)
    }
    private func cashValues(_ values: TaxValue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            detail("fields.date", display(values["date"]))
            detail("fields.amount", "\(display(values["amount"])) \(display(values["currency"]))")
            detail("cashAccount", account(values["accountId"]))
            detail(
                "cashTreatment",
                strings.t(
                    values["isTransfer"]?.boolValue == true
                        ? "portfolioImport.session.cashTransfer" : "portfolioImport.session.cashExpense"))
        }
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
            detail("adjustment.kind", strings.t("portfolioImport.session.adjustment.kind.\(display(values["kind"]))"))
            detail(
                "adjustment.basis",
                strings.t("portfolioImport.session.adjustment.basis.\(display(values["basisPolicy"]))"))
        }
    }
    private var fields: [String] {
        let keys =
            action.isCash == true
            ? ["date", "type", "amount", "currency", "memo"]
            : [
                "date", "type", "units", "price_per_unit", "amount", "fees", "taxes", "currency", "fx_rate_to_eur",
                "dividend_amount_convention", "income_recognition_role",
            ]
        return keys.filter {
            nonnull(action.source?[$0]) || nonnull(action.existing?[$0]) || nonnull(action.importedExisting?[$0])
        }
    }
    private var comparison: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    Text(strings.t("portfolioImport.session.field"))
                    Text(strings.t("portfolioImport.session.sourceValues"))
                    if action.existing != nil { Text(strings.t("portfolioImport.session.existingValues")) }
                    if action.importedExisting != nil { Text(strings.t("portfolioImport.session.importedValues")) }
                }.fontWeight(.medium)
                ForEach(fields, id: \.self) { field in
                    GridRow {
                        Text(
                            strings.t(
                                field == "memo"
                                    ? "txPage.field.description"
                                    : action.isCash == true && field == "amount"
                                        ? "txPage.field.amount" : "portfolioImport.session.fields.\(field)"))
                        Text(verbatim: display(action.source?[field], field: field))
                        if action.existing != nil { Text(verbatim: display(action.existing?[field], field: field)) }
                        if action.importedExisting != nil {
                            Text(verbatim: display(action.importedExisting?[field], field: field))
                        }
                    }.padding(.vertical, 3).background(
                        (action.corrections?.contains(field) ?? false) ? theme.foreground.opacity(0.06) : .clear)
                }
            }.font(.caption).monospacedDigit()
        }
    }
    private func nonnull(_ value: TaxValue?) -> Bool { value != nil && value != .null }
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
