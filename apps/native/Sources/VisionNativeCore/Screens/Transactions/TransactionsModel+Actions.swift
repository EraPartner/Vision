import Foundation

/// A bulk dialog of the bulk actions bar.
public enum TransactionBulkDialog: Equatable, Sendable {
    /// Change category… (`BulkRecategorizeDialog`).
    case recategorize
    /// Change payee… (`BulkRecipientDialog`).
    case recipient
    /// Export selected… (`BulkExportDialog`).
    case export
    /// Apply tags… (`BulkTagDialog`).
    case tag
    /// Split… (`BulkSplitDialog`).
    case split
}

/// A bulk alert (`useConfirmDialog`).
public enum TransactionBulkConfirmation: Equatable, Sendable {
    /// Delete {count} transactions? (destructive).
    case delete(count: Int)
    /// Exclude {n} transactions from totals?
    case deactivate(count: Int)
    /// Link existing transfer records? with both records.
    case markTransfer(TransactionRow, TransactionRow)
}

/// What the bulk dialogs hold between openings.
public struct TransactionBulkDrafts: Equatable, Sendable {
    /// Change category: `nil` is No category.
    public var categoryId: CategoryID?
    public var recipientId: RecipientID?
    /// The export format stays as chosen.
    public var exportFormat: ExportFormat = .csv
    /// Apply tags: the slugs to add and to remove; they stay when the dialog is dismissed.
    public var tagsToAdd: [String] = []
    public var tagsToRemove: [String] = []
    public var splitRecipientId: RecipientID?
    public var splitMode: BulkSplitMode = .equal

    public init() {}

    /// Nothing to apply in the tag dialog.
    public var tagsEmpty: Bool { tagsToAdd.isEmpty && tagsToRemove.isEmpty }
}

extension CreatedRecipient {
    /// The payee without `created`.
    public var recipient: OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: name, primaryBankAccount: primaryBankAccount, defaultCategoryId: defaultCategoryId,
            defaultCategoryName: defaultCategoryName, primaryRecipientId: primaryRecipientId,
            primaryRecipientName: primaryRecipientName, aliasCount: aliasCount, notes: notes, isActive: isActive,
            createdAt: createdAt, updatedAt: updatedAt, links: links)
    }
}

// MARK: - Add transaction

extension TransactionsModel {
    /// The sheet's primary button, Enter and ⌘Enter; Add anyway resubmits with
    /// `allowDuplicate`. An expense or income is one create (a 409 shows the duplicate
    /// prompt and toasts `addTxn.duplicateError`); a transfer creates (or reuses) a payee
    /// named after each counterpart account, posts the outflow and the inflow, then links
    /// them. On success the form resets, the sheet closes and the created (outflow) row is
    /// selected on `/transactions` (`navigate("/transactions", { replace, state })`).
    public func submitAdd(allowDuplicate: Bool = false) async {
        guard let form = addForm, !form.isPending else { return }
        let format = settings.numberFormat
        if allowDuplicate {
            guard form.duplicateDetected else { return }
        } else if !form.checkValid(format: format) {
            return
        }
        guard form.currencyOrDefault != nil else {
            // The typed currency is not a code; the server used to refuse it with this toast.
            post(.error, "transactions.createFailedTitle")
            return
        }
        form.isPending = true
        defer { form.isPending = false }
        if form.draft.kind == .transfer {
            await submitTransfer(form, format: format)
            return
        }
        guard let body = form.transactionBody(format: format, allowDuplicate: allowDuplicate) else { return }
        do {
            let created = try await service.createTransaction(body)
            await finishAdd(created)
        } catch {
            if case .client(let failure)? = error as? APIError, failure.code == .conflict {
                form.markDuplicate()
                post(.error, "addTxn.duplicateError")
            } else {
                post(.error, "transactions.createFailedTitle", detail: errorText(error))
            }
        }
    }

    /// `useCreateTransfer`.
    private func submitTransfer(_ form: AddTransactionModel, format: NumberFormat) async {
        let draft = form.draft
        guard let magnitude = form.magnitude(format: format), let fromId = draft.accountId,
            let toId = draft.toAccountId, let currency = form.currencyOrDefault
        else { return }
        let bulk = bulkService
        do {
            async let toPayee = bulk.createRecipient(name: draft.toAccountName)
            async let fromPayee = bulk.createRecipient(name: draft.accountName)
            let (toRecipient, fromRecipient) = try await (toPayee, fromPayee)
            let memo = AddTransactionModel.trimmedOrNil(draft.memo)
            let comment = AddTransactionModel.trimmedOrNil(draft.comment)
            let outflow = try await service.createTransaction(
                OpenAPI.TransactionCreate(
                    transactionDate: draft.date, accountId: fromId, recipientId: toRecipient.id, memo: memo,
                    amount: -magnitude, currency: currency, comment: comment))
            let inflow = try await service.createTransaction(
                OpenAPI.TransactionCreate(
                    transactionDate: draft.date, accountId: toId, recipientId: fromRecipient.id, memo: memo,
                    amount: magnitude, currency: currency, comment: comment))
            try await bulk.markTransfer(outflow.id, inflow.id)
            await finishAdd(outflow)
        } catch {
            post(.error, "transactions.createFailedTitle", detail: errorText(error))
            fetchedAt = nil
        }
    }

    private func finishAdd(_ created: OpenAPI.Transaction) async {
        addForm = nil
        dismissAdd()
        fetchedAt = nil
        selection.clear()
        if let shell, shell.route.path == TransactionsRoutes.path {
            // `id` is read and removed by `sync`, which then selects the row in the first page.
            shell.replace(with: "\(TransactionsRoutes.path)?\(TransactionsRoutes.selectParameter)=\(created.id)")
        } else if let shell, shell.route.path == InsightsRoutes.home {
            shell.home?.invalidate()
            shell.navigate(to: "\(TransactionsRoutes.path)?\(TransactionsRoutes.selectParameter)=\(created.id)")
        }
        await refreshNeedsCategoryCount()
    }

    /// The payee combobox's create row: `POST /api/recipients`, then the payee is known to
    /// the pickers. Toasts `recipients.created`, `recipients.exists` (info) or
    /// `recipients.createFailedTitle`. Returns the payee's id.
    public func createRecipient(named name: String) async -> RecipientID? {
        do {
            let created = try await bulkService.createRecipient(name: name)
            pickers.remember(created.recipient)
            if created.created {
                post(.success, "recipients.created")
            } else {
                post(.info, "recipients.exists")
            }
            return created.id
        } catch {
            post(.error, "recipients.createFailedTitle", detail: errorText(error))
            return nil
        }
    }

    /// The Add sheet's payee create row: the new payee becomes the form's payee.
    public func createRecipientForAdd(named name: String) async {
        guard let id = await createRecipient(named: name) else { return }
        await addForm?.selectRecipient(id)
    }
}

// MARK: - Split transaction

extension TransactionsModel {
    /// The dialog's Split: `POST /api/splits/batch`; toasts `splits.created` and closes, or
    /// `splits.createFailed`.
    public func submitSplit() async {
        guard let form = splitForm else { return }
        let format = settings.numberFormat
        guard form.canSubmit(format: format), let shares = form.shares(format: format) else { return }
        form.isPending = true
        defer { form.isPending = false }
        do {
            try await splitsService.createSplits(transactionId: form.row.id, shares: shares)
            owes.invalidate()
            form.resetEntries()
            post(.success, "splits.created")
            if splitForm === form { dismissSplit() }
        } catch {
            post(.error, "splits.createFailed", detail: errorText(error))
        }
    }
}

// MARK: - Bulk actions

extension TransactionsModel {
    /// `effectiveCount`: the matching total in filter mode, else the checked rows.
    public var bulkCount: Int {
        selection.mode == .filter ? total : selection.ids.count
    }

    /// The bar shows while rows are checked.
    public var showsBulkBar: Bool { !selection.ids.isEmpty }

    /// Select all {n} matching filter: every loaded row is checked and more match.
    public var canSelectAllMatching: Bool {
        selection.mode == .ids && selection.ids.count == (rows?.count ?? 0) && total > (rows?.count ?? 0)
    }

    public func selectAllMatching() {
        selection.selectAllMatching()
    }

    /// Tag and Split take explicit ids only.
    public var bulkIdsOnly: Bool { selection.mode == .filter }

    /// `buildSelector`.
    public var bulkSelector: BulkSelector {
        if selection.mode == .filter {
            return .filter(BulkFilterSelection(filters: filters, search: search, active: !showAll), expectedCount: total)
        }
        return .ids(selection.ids.sorted())
    }

    /// The two checked rows Mark as internal transfer links, when they qualify
    /// (`eligibleExistingTransferPair`).
    public var transferPair: (TransactionRow, TransactionRow)? {
        guard selection.mode == .ids, selection.ids.count == 2 else { return nil }
        let legs = (rows ?? []).filter { selection.contains($0.id) }
        guard legs.count == 2 else { return nil }
        let first = legs[0]
        let second = legs[1]
        func eligible(_ leg: TransactionRow) -> Bool {
            // A decoded currency already is three capitals (`CurrencyCode`).
            leg.id.rawValue > 0 && (leg.accountId?.rawValue ?? 0) > 0 && leg.isActive && leg.transferPeerId == nil
                && (leg.transferSource == nil || ["auto", "manual"].contains(leg.transferSource ?? ""))
                && leg.amount != 0 && !leg.date.isEmpty && leg.currency != nil
        }
        guard first.id != second.id, eligible(first), eligible(second), first.accountId != second.accountId,
            (first.amount < 0) != (second.amount < 0)
        else { return nil }
        return (first, second)
    }

    /// Clear selection: back to ids mode.
    public func clearBulkSelection() {
        selection.clear()
    }

    // MARK: Dialogs and alerts

    /// A dialog of the bulk menu; Tag and Split need ids mode.
    public func openBulkDialog(_ dialog: TransactionBulkDialog) {
        if (dialog == .tag || dialog == .split) && bulkIdsOnly { return }
        bulkDialog = dialog
    }

    /// Cancel or a dismissal: Change category, Change payee and Split reset; the tags stay
    /// (Cancel clears them through `cancelBulkTags`), and so does the export format.
    public func closeBulkDialog() {
        switch bulkDialog {
        case .recategorize?: bulkDrafts.categoryId = nil
        case .recipient?: bulkDrafts.recipientId = nil
        case .split?:
            bulkDrafts.splitRecipientId = nil
            bulkDrafts.splitMode = .equal
        default: break
        }
        bulkDialog = nil
    }

    /// The tag dialog's Cancel: resets and closes.
    public func cancelBulkTags() {
        bulkDrafts.tagsToAdd = []
        bulkDrafts.tagsToRemove = []
        bulkDialog = nil
    }

    public func setBulkCategory(_ id: CategoryID?) { bulkDrafts.categoryId = id }
    public func setBulkRecipient(_ id: RecipientID?) { bulkDrafts.recipientId = id }
    public func setBulkExportFormat(_ format: ExportFormat) { bulkDrafts.exportFormat = format }
    public func setBulkTagsToAdd(_ slugs: [String]) { bulkDrafts.tagsToAdd = slugs }
    public func setBulkTagsToRemove(_ slugs: [String]) { bulkDrafts.tagsToRemove = slugs }
    public func setBulkSplitRecipient(_ id: RecipientID?) { bulkDrafts.splitRecipientId = id }
    public func setBulkSplitMode(_ mode: BulkSplitMode) { bulkDrafts.splitMode = mode }

    /// Delete: asks first.
    public func requestBulkDelete() {
        bulkConfirmation = .delete(count: bulkCount)
    }

    /// Exclude from totals: asks first; Include in totals does not.
    public func requestBulkSetActive(_ active: Bool) async {
        if active {
            await runBulkUpdate(BulkUpdateFields(isActive: true), closing: nil)
        } else {
            bulkConfirmation = .deactivate(count: bulkCount)
        }
    }

    /// Mark as internal transfer: asks with both records.
    public func requestMarkTransfer() {
        guard let pair = transferPair else { return }
        bulkConfirmation = .markTransfer(pair.0, pair.1)
    }

    public func cancelBulkConfirmation() {
        bulkConfirmation = nil
    }

    /// The alert's title, message and confirm label.
    public func bulkConfirmationText() -> (title: String, message: String, action: String)? {
        switch bulkConfirmation {
        case .delete(let count)?:
            return (
                strings.tc("txPage.bulk.confirmDeleteTitle", count), strings.tc("txPage.bulk.confirmDeleteBody", count),
                strings.t("txPage.bulk.delete")
            )
        case .deactivate(let count)?:
            return (
                strings.t("txPage.bulk.confirmDeactivateTitle", ["n": String(count)]),
                strings.t("txPage.bulk.confirmDeactivateBody"), strings.t("txPage.bulk.deactivate")
            )
        case .markTransfer(let first, let second)?:
            return (
                strings.t("txPage.bulk.confirmTransferTitle"),
                strings.t("txPage.bulk.confirmTransferBody", Self.transferVariables(first, second)),
                strings.t("txPage.bulk.markTransfer")
            )
        case nil:
            return nil
        }
    }

    /// `confirmTransferBody`'s values: id, account (the bank string, else the account id),
    /// date, amount and currency of each record.
    nonisolated static func transferVariables(_ first: TransactionRow, _ second: TransactionRow) -> [String: String] {
        var variables: [String: String] = [:]
        for (prefix, leg) in [("first", first), ("second", second)] {
            let bank = leg.bank.flatMap { $0.isEmpty ? nil : $0 } ?? leg.accountId.map { String($0.rawValue) } ?? ""
            variables["\(prefix)Id"] = String(leg.id.rawValue)
            variables["\(prefix)Account"] = bank
            variables["\(prefix)Date"] = leg.date
            variables["\(prefix)Amount"] = VisionFormat.plain(leg.amount)
            variables["\(prefix)Currency"] = leg.currency?.rawValue ?? ""
        }
        return variables
    }

    /// `ExistingTransferLeg`: the fields the confirmation showed and the link depends on. A
    /// category or payee edit to a leg while the alert asked does not cancel the link.
    nonisolated static func sameTransferLeg(_ current: TransactionRow, _ asked: TransactionRow) -> Bool {
        current.id == asked.id && current.accountId == asked.accountId && current.amount == asked.amount
            && current.date == asked.date && current.currency == asked.currency
            && current.isActive == asked.isActive && current.transferPeerId == asked.transferPeerId
    }

    /// The alert's confirm button.
    public func confirmBulk() async {
        guard let confirmation = bulkConfirmation else { return }
        bulkConfirmation = nil
        switch confirmation {
        case .delete:
            await runBulkDelete()
        case .deactivate:
            await runBulkUpdate(BulkUpdateFields(isActive: false), closing: nil)
        case .markTransfer(let first, let second):
            guard let current = transferPair, Self.sameTransferLeg(current.0, first),
                Self.sameTransferLeg(current.1, second)
            else {
                post(.error, "txPage.bulk.failed", detail: strings.t("txPage.bulk.transferSelectionChanged"))
                return
            }
            await runMarkTransfer(first.id, second.id)
        }
    }

    // MARK: Submits

    /// Change category: `fields.category_id` (null for No category).
    public func applyBulkCategory() async {
        await runBulkUpdate(BulkUpdateFields(categoryId: .some(bulkDrafts.categoryId)), closing: .recategorize)
    }

    /// Change payee: `fields.recipient_id`; needs a payee.
    public func applyBulkRecipient() async {
        guard let id = bulkDrafts.recipientId else { return }
        await runBulkUpdate(BulkUpdateFields(recipientId: id), closing: .recipient)
    }

    /// `useBulkUpdateTransactions`; on success the dialog closes and the selection clears.
    private func runBulkUpdate(_ fields: BulkUpdateFields, closing dialog: TransactionBulkDialog?) async {
        guard !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            let result = try await bulkService.bulkUpdate(bulkSelector, fields: fields)
            let toast = Self.bulkUpdatedToast(result, language: strings.language)
            post(.success, toast.key, toast.variables)
            if let dialog, bulkDialog == dialog { closeBulkDialog() }
            selection.clear()
            await reloadAfterBulk()
        } catch {
            post(.error, "txPage.bulk.failed", detail: errorText(error))
        }
    }

    private func runBulkDelete() async {
        guard !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            let result = try await bulkService.bulkDelete(bulkSelector)
            let toast = Self.bulkDeletedToast(result, language: strings.language)
            post(.success, toast.key, toast.variables)
            selection.clear()
            await reloadAfterBulk()
        } catch {
            post(.error, "txPage.bulk.failed", detail: errorText(error))
        }
    }

    /// `useBulkDeleteTransactions`' toast.
    static func bulkDeletedToast(_ result: BulkDeleteResult, language: NativeLanguage)
        -> (key: String, variables: [String: String])
    {
        if result.matched != result.requested {
            return pluralToast(
                "txPage.bulk.deletedSelectionChanged", result.deleted, language: language,
                [
                    "affected": String(result.deleted), "requested": String(result.requested),
                    "matched": String(result.matched),
                ])
        }
        if result.deleted == result.requested {
            return pluralToast("txPage.bulk.deleted", result.deleted, language: language, ["n": String(result.deleted)])
        }
        return pluralToast(
            "txPage.bulk.deletedOf", result.requested, language: language,
            [
                "affected": String(result.deleted), "requested": String(result.requested),
                "skipped": String(result.requested - result.deleted),
            ])
    }

    /// The plural key `tc` picks for `count`, with `{count}` filled like `tc`.
    static func pluralToast(
        _ key: String, _ count: Int, language: NativeLanguage, _ variables: [String: String] = [:]
    ) -> (key: String, variables: [String: String]) {
        let category = PluralCategory.of(count, language: language).rawValue
        return ("\(key).\(category)", variables.merging(["count": String(count)]) { given, _ in given })
    }

    /// Download: `POST /api/transactions/bulk-export` (ids or filter), saved through the Save
    /// panel; toasts `txPage.bulk.exportedCount` and closes.
    public func applyBulkExport() async {
        guard !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        let selector = bulkSelector
        let format = bulkDrafts.exportFormat
        do {
            let file = try await bulkService.bulkExport(selector, format: format)
            if bulkDialog == .export { bulkDialog = nil }
            let fallback: Int
            if case .ids(let ids) = selector { fallback = ids.count } else { fallback = 0 }
            let count = file.exportedCount ?? fallback
            if try await save(file.data, TransactionBulkExportRequest.fileName(format, now: now())) {
                let toast = Self.pluralToast("txPage.bulk.exportedCount", count, language: strings.language)
                post(.success, toast.key, toast.variables)
            }
        } catch is CancellationError {
            return
        } catch {
            post(.error, "txPage.bulk.failed", detail: errorText(error))
        }
    }

    /// Apply tags: ids only; toasts `tags.bulkApplied` or `tags.bulkFailed`.
    public func applyBulkTags() async {
        guard !bulkBusy, !bulkIdsOnly, !bulkDrafts.tagsEmpty else { return }
        let add = bulkDrafts.tagsToAdd
        let remove = bulkDrafts.tagsToRemove
        bulkDrafts.tagsToAdd = []
        bulkDrafts.tagsToRemove = []
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            _ = try await bulkService.bulkTag(ids: selection.ids.sorted(), add: add, remove: remove)
            post(.success, "tags.bulkApplied")
            if bulkDialog == .tag { bulkDialog = nil }
            selection.clear()
            await reloadAfterBulk()
        } catch {
            post(.error, "tags.bulkFailed", detail: errorText(error))
        }
    }

    /// Split: ids only; `POST /api/splits/bulk`. The toast names what was not split.
    public func applyBulkSplit() async {
        guard !bulkBusy, !bulkIdsOnly, let recipientId = bulkDrafts.splitRecipientId else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            let result = try await splitsService.bulkSplit(
                transactionIds: selection.ids.sorted(), recipientId: recipientId, mode: bulkDrafts.splitMode)
            owes.invalidate()
            let detail = Self.bulkSplitDetail(result, strings: strings)
            if result.split == 0 {
                post(.info, "splits.bulkNothingSplit", detail: detail)
            } else {
                let toast = Self.pluralToast("splits.bulkCreated", result.split, language: strings.language)
                post(.success, toast.key, toast.variables, detail: detail)
            }
            if bulkDialog == .split { closeBulkDialog() }
            selection.clear()
            await reloadAfterBulk()
        } catch {
            post(.error, "splits.bulkCreateFailed", detail: errorText(error))
        }
    }

    /// The bulk split toast's description: the already-split and the other skipped rows.
    static func bulkSplitDetail(_ result: OpenAPI.BulkSplitResult, strings: any Localizing) -> String? {
        var lines: [String] = []
        if result.skippedAlreadySplit > 0 {
            lines.append(strings.tc("splits.bulkSkippedAlreadySplit", result.skippedAlreadySplit))
        }
        let other = result.skippedZeroAmount + result.skippedMissing
        if other > 0 { lines.append(strings.tc("splits.bulkSkippedOther", other)) }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }

    private func runMarkTransfer(_ first: TransactionID, _ second: TransactionID) async {
        guard !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            try await bulkService.markTransfer(first, second)
            post(.success, "txPage.bulk.markTransferSuccess")
            selection.clear()
            await reloadAfterBulk()
        } catch {
            post(.error, "txPage.bulk.failed", detail: errorText(error))
        }
    }

    /// `invalidateTransactionData`: the first page and the Needs category count again.
    private func reloadAfterBulk() async {
        await reload()
        await refreshNeedsCategoryCount()
    }
}
