import SwiftUI
import VisionNativeCore

/// Lazy rows keep large imported histories usable. Edits require the complete history.
struct PortfolioDetailHistoryTable: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let holding: PortfolioHolding
    let shell: NativeShellModel
    @State private var query = LocalTableQuery()
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var rows: [PortfolioTransaction] {
        query.apply(model.transactions, keys: ["type", "date", "note", "amount", "currency"], value: rawValue)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.historyLoading { ProgressView().frame(maxWidth: .infinity).padding(16) }
            if let error = model.historyError {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.openDetail(id: holding.id) } }
            }
            if model.historyComplete && model.transactions.isEmpty {
                VisionEmptyState(symbol: "list.bullet.rectangle", title: strings.t("invDetail.noTransactions")) {
                    if holding.isActive, let investment = model.investment(id: holding.id) {
                        Button(strings.t("form.addTransaction.title")) {
                            editing.bindTransactions(model.transactions)
                            editing.beginAddTransaction(investment: investment, bookingCurrency: holding.currency)
                        }
                    }
                }.padding(40)
            } else {
                ScrollView {
                    LocalDataTable(
                        title: "", subtitle: "", columns: columns, rows: rows, totalCount: model.transactions.count,
                        query: $query,
                        filterValues: { key in
                            LocalTableQuery.uniqueValues(model.transactions, key: key, value: rawValue)
                        }, strings: strings
                    ) {
                        Text(strings.t("table.noFilterResults"))
                    }
                }
            }
        }
    }
    private var columns: [LocalDataColumn<PortfolioTransaction>] {
        [
            LocalDataColumn(
                key: "type", title: strings.t("addPortTxn.type"), width: 170, minWidth: 130,
                cell: { transaction in
                    AnyView(
                        VStack(alignment: .leading, spacing: 5) {
                            VisionBadge(
                                text: label(transaction.type.rawValue),
                                tone: transaction.type == .fee || transaction.type == .tax ? .muted : .primary)
                            Text(VisionFormat.appDate(transaction.date, format: shell.settings.dateFormat)).font(
                                .caption
                            ).foregroundStyle(theme.secondaryLabel)
                        })
                }),
            LocalDataColumn(
                key: "note", title: strings.t("addPortTxn.note"), width: 260, minWidth: 180, flexible: true,
                cell: { transaction in
                    AnyView(
                        VStack(alignment: .leading, spacing: 5) {
                            if let units = transaction.units {
                                let price = transaction.pricePerUnit ?? (units != 0 ? transaction.amount / units : 0)
                                Text(
                                    strings.t(
                                        "invDetail.unitsAt",
                                        [
                                            "units": VisionFormat.decimal(
                                                units, fractionDigits: 4, locale: shell.settings.numberFormat.locale),
                                            "price": money(price, currency: transaction.currency),
                                        ])
                                ).font(.caption).monospacedDigit()
                            }
                            if let note = transaction.note { Text(note).font(.callout).textSelection(.enabled) }
                            if transaction.incomeRecognitionRole == .includedInUnits {
                                Text(strings.t("portfolio.inKindIncome")).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            }
                        })
                }),
            LocalDataColumn(
                key: "amount", title: strings.t("form.addTransaction.amount"), width: 180, minWidth: 150,
                alignment: .trailing,
                cell: { transaction in
                    let debit = [.buy, .fee, .tax].contains(transaction.type)
                    let amount = debit ? -abs(transaction.amount) : abs(transaction.amount)
                    return AnyView(
                        VStack(alignment: .trailing, spacing: 5) {
                            Text(money(amount, currency: transaction.currency, signed: true)).monospacedDigit()
                                .foregroundStyle(
                                    transaction.incomeRecognitionRole == .includedInUnits
                                        ? theme.secondaryLabel : debit ? theme.loss : theme.gain)
                            if let fees = transaction.fees, fees > 0 {
                                Text(
                                    strings.t("invDetail.fee", ["amount": money(fees, currency: transaction.currency)])
                                ).font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                            if let taxes = transaction.taxes, taxes > 0 {
                                Text(
                                    strings.t("invDetail.tax", ["amount": money(taxes, currency: transaction.currency)])
                                ).font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        })
                }),
            LocalDataColumn(
                key: "actions", title: "", width: 76, minWidth: 76,
                cell: { transaction in
                    AnyView(
                        HStack {
                            if holding.isActive, let investment = model.investment(id: holding.id) {
                                Button {
                                    editing.beginEditTransaction(investment: investment, transaction: transaction)
                                } label: {
                                    Image(systemName: "pencil")
                                }.buttonStyle(.borderless)
                                    .accessibilityLabel(
                                        strings.t("aria.editTransaction") + ": " + label(transaction.type.rawValue) + " · "
                                            + VisionFormat.appDate(transaction.date, format: shell.settings.dateFormat)
                                    )
                                    .disabled(!model.historyComplete || model.historyLoading)
                                Button(role: .destructive) {
                                    editing.confirmDeleteTransaction(transaction: transaction)
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.borderless).accessibilityLabel(
                                    strings.t("aria.deleteTransaction") + ": " + label(transaction.type.rawValue) + " · "
                                        + VisionFormat.appDate(transaction.date, format: shell.settings.dateFormat)
                                )
                                .disabled(!model.historyComplete || model.historyLoading)
                            }
                        })
                }),
        ]
    }
    private func label(_ type: String) -> String {
        let key = "portfolio.txnType." + type
        let text = strings.t(key)
        return text == key ? type : text
    }
    private func money(_ amount: Decimal, currency: CurrencyCode, signed: Bool = false) -> String {
        MoneyText.text(amount, currency: currency, settings: shell.settings, signed: signed)
    }
    private func rawValue(_ transaction: PortfolioTransaction, _ key: String) -> TableRawValue {
        switch key {
        case "type": .text(transaction.type.rawValue)
        case "date": .text(transaction.date)
        case "note": transaction.note.map(TableRawValue.text) ?? .none
        case "amount": .number(transaction.amount)
        case "currency": .text(transaction.currency.rawValue)
        default: .none
        }
    }
}
