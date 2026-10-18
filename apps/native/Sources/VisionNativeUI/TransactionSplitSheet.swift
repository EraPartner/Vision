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
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("splitDialog.buttonTitle"))
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                Text(strings.t("splitDialog.total", ["amount": money(form.absoluteAmount)]))
                    .font(.callout)
                    .foregroundStyle(theme.secondaryLabel)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 8)
            ScrollView {
                content
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
            }
            Divider()
            footer
        }
        .frame(minWidth: 460, idealWidth: 500, minHeight: 440, idealHeight: 620)
        .foregroundStyle(theme.foreground)
        .task { await form.load() }
        .task { await model.pickers.load() }
    }

    private func money(_ amount: Decimal) -> String {
        MoneyText.text(amount, currency: form.currency, settings: settings, signed: false)
    }

    // MARK: Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !form.isLoadingExisting {
                existingNote
                if form.exceedsTotal(format: format) {
                    note(
                        strings.t("splitDialog.exceedsTotal", ["remaining": money(form.remainingCapacity)]),
                        symbol: "exclamationmark.triangle", tint: theme.destructive)
                }
            }
            Picker(
                strings.t("splitDialog.splitType"),
                selection: Binding(get: { form.splitType }, set: { form.setSplitType($0) })
            ) {
                ForEach(SplitType.allCases, id: \.self) { type in
                    Text(strings.t(type.labelKey)).tag(type)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
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
            .buttonStyle(.bordered)
            .controlSize(.small)
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
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submit)
                    .accessibilityLabel("\(strings.t("splitDialog.amountOwed")) \(number)")
                }
                TextField(
                    strings.t("splitDialog.noteOptional"),
                    text: Binding(get: { entry.note }, set: { form.setNote(entry.id, to: $0) })
                )
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
                .accessibilityLabel("\(strings.t("splitDialog.noteOptional")) \(number)")
            }
            if form.entries.count > 1 {
                Button {
                    form.removeEntry(entry.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .help(strings.t("aria.removeEntry"))
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
        HStack(spacing: 12) {
            Spacer()
            Button(strings.t("common.cancel")) {
                model.dismissSplit()
            }
            .keyboardShortcut(.cancelAction)
            Button(action: submit) {
                HStack(spacing: 6) {
                    if form.isPending {
                        ProgressView().controlSize(.small)
                    }
                    Text(strings.t(form.isPending ? "splitDialog.splitting" : "splitDialog.split"))
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(!form.canSubmit(format: format))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    private func submit() {
        Task { await model.submitSplit() }
    }
}
