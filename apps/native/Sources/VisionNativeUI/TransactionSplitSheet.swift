import SwiftUI
import VisionNativeCore

/// `SplitTransactionDialog` as a sheet: the total, what the transaction is already split
/// into, the Equal split / Others pay all / Custom amounts control with its summary, a card
/// per person (payee, amount owed for custom, note, remove), Add person, and Split. Return
/// in a field splits; Escape or Cancel closes.
struct TransactionSplitSheet: View {
    let model: TransactionsModel
    let form: SplitDialogModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var format: NumberFormat { settings.numberFormat }

    var body: some View {
        VStack(spacing: 0) {
            VisionDialogHeader(
                title: strings.t("splitDialog.buttonTitle"),
                description: strings.t("splitDialog.total", ["amount": money(form.absoluteAmount)]),
                closeLabel: strings.t("common.close"), onClose: { model.dismissSplit() })
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 4)
            ScrollView {
                content
                    .padding(.horizontal, 24)
                    .padding(.vertical, 16)
            }
            Divider()
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(theme.foreground)
        .task { await form.load() }
        .task { await model.pickers.load() }
    }

    private func money(_ amount: Decimal) -> String {
        MoneyText.text(amount, currency: form.currency, settings: settings, signed: false)
    }

    // MARK: Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !form.isLoadingExisting {
                existingNote
                if form.exceedsTotal(format: format) {
                    note(
                        strings.t("splitDialog.exceedsTotal", ["remaining": money(form.remainingCapacity)]),
                        symbol: "exclamationmark.triangle", tint: theme.destructive)
                }
            }
            VisionSegmentedControl(
                selection: Binding(get: { form.splitType }, set: { form.setSplitType($0) }),
                options: SplitType.allCases.map { type in
                    VisionSegmentOption(value: type, title: strings.t(type.labelKey))
                }
            )
            .accessibilityLabel(strings.t("splitDialog.splitType"))
            summary
            ForEach(Array(form.entries.enumerated()), id: \.element.id) { index, entry in
                card(entry, number: index + 1)
            }
            Button {
                form.addEntry()
            } label: {
                Label(strings.t("splitDialog.addPerson"), systemImage: "plus")
            }
            .buttonStyle(.vision(.outline, size: .sm))
            if form.splitType == .custom && !form.validEntries.isEmpty {
                Text(
                    strings.t(
                        "splitDialog.othersOwe",
                        ["x": money(form.customTotal(format: format)), "total": money(form.absoluteAmount)])
                )
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
            }
        }
    }

    /// Already split into …, or not split yet.
    private var existingNote: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(
                form.existing.isEmpty
                    ? strings.t("splitDialog.notSplitYet") : strings.tc("splitDialog.alreadySplit", form.existing.count))
            if !form.existingRecipientNames.isEmpty {
                Text(strings.t("splitDialog.existingRecipients", ["recipients": form.existingRecipientNames]))
                    .foregroundStyle(theme.secondaryLabel)
            }
            ForEach(form.existing, id: \.id) { split in
                Text(
                    strings.t(
                        "splitDialog.existingSplitLine",
                        [
                            "recipient": split.recipientName.flatMap { $0.isEmpty ? nil : $0 }
                                ?? strings.t("txPage.field.unknown"),
                            "amount": money(split.amount),
                        ])
                )
                .foregroundStyle(theme.secondaryLabel)
            }
        }
        .font(.callout)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).fill(theme.muted))
    }

    private func note(_ text: String, symbol: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).fill(tint.opacity(0.08)))
    }

    @ViewBuilder
    private var summary: some View {
        if form.splitType == .equal && !form.validEntries.isEmpty {
            Text(
                strings.t("splitDialog.eachPays", ["amount": money(form.equalShare), "n": String(form.totalPeople)])
            )
            .font(.callout)
            .foregroundStyle(theme.secondaryLabel)
        }
        if form.splitType == .full && !form.validEntries.isEmpty {
            Text(
                strings.tc(
                    "splitDialog.othersPayAllSummary", form.validEntries.count, ["amount": money(form.absoluteAmount)])
            )
            .font(.callout)
            .foregroundStyle(theme.secondaryLabel)
        }
    }

    private func card(_ entry: SplitEntry, number: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                RecipientPicker(pickers: model.pickers, value: entry.recipientId, strings: strings) { id in
                    form.setRecipient(entry.id, to: id)
                }
                .accessibilityLabel("\(strings.t("recipientsPage.col.recipient")) \(number)")
                if let share = form.fullShare(for: entry.id) {
                    Text(strings.t("splitDialog.owes", ["amount": money(share)]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                if form.splitType == .custom {
                    TextField(
                        strings.t("splitDialog.amountOwed"),
                        text: Binding(get: { entry.amount }, set: { form.setAmount(entry.id, to: $0) })
                    )
                    .textFieldStyle(.vision)
                    .onSubmit(submit)
                    .accessibilityLabel("\(strings.t("splitDialog.amountOwed")) \(number)")
                }
                TextField(
                    strings.t("splitDialog.noteOptional"),
                    text: Binding(get: { entry.note }, set: { form.setNote(entry.id, to: $0) })
                )
                .textFieldStyle(.vision)
                .onSubmit(submit)
                .accessibilityLabel("\(strings.t("splitDialog.noteOptional")) \(number)")
            }
            if form.entries.count > 1 {
                Button {
                    form.removeEntry(entry.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.vision(.ghost, size: .iconSm))
                .foregroundStyle(theme.secondaryLabel)
                .visionTooltip(strings.t("aria.removeEntry"))
                .accessibilityLabel(strings.t("aria.removeEntry"))
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.foreground.opacity(0.04)))
    }

    // MARK: Footer

    private var footer: some View {
        VisionDialogFooter {
            Button(strings.t("common.cancel")) {
                model.dismissSplit()
            }
            .buttonStyle(.visionOutline)
            .keyboardShortcut(.cancelAction)
            Button(action: submit) {
                HStack(spacing: 6) {
                    if form.isPending {
                        ProgressView().controlSize(.small)
                    }
                    Text(strings.t(form.isPending ? "splitDialog.splitting" : "splitDialog.split"))
                }
            }
            .buttonStyle(.visionPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(!form.canSubmit(format: format))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }

    private func submit() {
        Task { await model.submitSplit() }
    }
}
