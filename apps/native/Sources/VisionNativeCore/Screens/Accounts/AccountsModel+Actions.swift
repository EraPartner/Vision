import Foundation

// The dialogs of `/accounts` and `/accounts/:id` and their writes.
extension AccountsModel {
    // MARK: Add / Edit account

    /// The header's and the empty state's Add account.
    public func openCreate() {
        form = AccountFormDraft(today: today, numberFormat: settings.numberFormat)
        formFocus = nil
    }

    /// The header menu's Edit.
    public func openEdit(_ account: OpenAPI.Account) {
        form = AccountFormDraft(editing: account, numberFormat: settings.numberFormat)
        formFocus = nil
    }

    /// Cancel, Escape or a click outside: the sheet closes.
    public func closeForm() {
        form = nil
        formFocus = nil
    }

    /// The sheet's submit (button or Return).
    public func submitForm() async {
        guard var draft = form, !isSavingForm else { return }
        let check = draft.check()
        form = draft
        switch check {
        case .blocked:
            return
        case .openingInvalid:
            formFocus = .openingBalance
            formFocusRequest += 1
            return
        case .openingDateMissing:
            formFocus = .openingDate
            formFocusRequest += 1
            return
        case .ready:
            formFocus = nil
        }
        isSavingForm = true
        switch draft.mode {
        case .create:
            await create(draft)
        case .edit(let id):
            await saveEdit(draft, id: id)
            isSavingForm = false
        }
    }

    private func create(_ draft: AccountFormDraft) async {
        let stamp = draft.openingStamp
        let created: AccountID
        do {
            created = try await service.createAccount(draft.createBody)
        } catch {
            isSavingForm = false
            post(.error, "accounts.createFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "accounts.created")
        if form?.mode == .create { closeForm() }
        // The sheet is gone: a new one must not wait on the opening balance and the refresh.
        isSavingForm = false
        if let stamp {
            await stampOpeningBalance(
                id: created, balance: stamp.balance, date: stamp.date, currency: draft.normalizedCurrency)
        }
        await refreshAfterWrite()
    }

    private func saveEdit(_ draft: AccountFormDraft, id: AccountID) async {
        do {
            try await service.updateAccount(id: id, patch: draft.patch)
        } catch {
            post(.error, "accounts.updateFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "accounts.updated")
        await refreshAfterWrite()
        if form?.mode == .edit(id: id) { closeForm() }
    }

    /// `setOpeningBalance` with the saved / warning / failed toast.
    @discardableResult
    private func stampOpeningBalance(id: AccountID, balance: Decimal, date: String, currency: CurrencyCode) async -> Bool {
        do {
            let warning = try await service.setOpeningBalance(id: id, balance: balance, date: date, currency: currency)
            if let warning {
                post(.info, "accounts.openingBalance.saved", detail: warning)
            } else {
                post(.success, "accounts.openingBalance.saved")
            }
            return true
        } catch {
            post(.error, "accounts.openingBalance.failed", detail: errorText(error))
            return false
        }
    }

    // MARK: Reconcile

    /// The drift chip, the row menu's and the balance card's Reconcile balance.
    public func openReconcile(_ account: OpenAPI.Account) {
        reconcile = ReconcileDraft(account: account, today: today, numberFormat: settings.numberFormat)
    }

    public func closeReconcile() {
        reconcile = nil
    }

    /// Save reading: `PUT /api/accounts/:id/statement-balances/:currency`.
    public func saveReading() async {
        guard let draft = reconcile, draft.pendingAction == nil, draft.canSaveReading,
            let balance = draft.parsedReading, let date = draft.readingDate
        else { return }
        reconcile?.pendingAction = .saveReading
        do {
            try await service.setStatementBalance(
                id: draft.account.id, currency: draft.selectedCurrency, balance: balance, date: date.ymd)
            post(.success, "accounts.reconcile.readingSaved")
            reconcile = nil
            await refreshAfterWrite()
        } catch {
            reconcile?.pendingAction = nil
            post(.error, "accounts.reconcile.readingFailed", detail: errorText(error))
        }
    }

    /// Accept computed balance / Add adjustment transaction: a typed reading is saved first,
    /// and a reading that already matches the ledger is the resolution.
    public func resolve(_ mode: ReconcileMode) async {
        guard let draft = reconcile, draft.pendingAction == nil, !draft.readingNeedsDate else { return }
        reconcile?.pendingAction = .resolve(mode)
        do {
            if draft.canSaveReading, let balance = draft.parsedReading, let date = draft.readingDate {
                try await service.setStatementBalance(
                    id: draft.account.id, currency: draft.selectedCurrency, balance: balance, date: date.ymd)
                if draft.previewIsZero {
                    post(.success, "accounts.reconcile.readingSaved")
                    reconcile = nil
                    await refreshAfterWrite()
                    return
                }
            }
            try await service.reconcile(id: draft.account.id, mode: mode, currency: draft.selectedCurrency)
            post(.success, mode == .accept ? "accounts.reconcile.acceptSaved" : "accounts.reconcile.adjustSaved")
            reconcile = nil
            await refreshAfterWrite()
        } catch {
            reconcile?.pendingAction = nil
            post(.error, "accounts.reconcile.failed", detail: errorText(error))
            // Two writes: the reading may have landed before the failure.
            await refreshAfterWrite()
        }
    }

    /// Set as opening balance (no statement anchor yet).
    public func backfillOpening() async {
        guard let draft = reconcile, draft.pendingAction == nil, draft.canBackfill else { return }
        reconcile?.pendingAction = .backfill
        let saved = await stampOpeningBalance(
            id: draft.account.id, balance: draft.backfillBalance, date: draft.backfillDate(today: today.ymd),
            currency: draft.selectedCurrency)
        if saved {
            reconcile = nil
            await refreshAfterWrite()
        } else {
            reconcile?.pendingAction = nil
        }
    }

    /// Show transactions since {date}: closes the dialog and opens the filtered ledger.
    public func showSince() {
        guard let draft = reconcile, let since = draft.sinceDate else { return }
        reconcile = nil
        navigate(to: AccountsRoutes.sinceRoute(draft.account.id, since: since))
    }

    // MARK: Set opening balance

    public func openOpeningBalance(_ account: OpenAPI.Account) {
        opening = OpeningBalanceDraft(
            account: account, today: today, numberFormat: settings.numberFormat, calendar: calendar)
    }

    public func closeOpeningBalance() {
        opening = nil
    }

    /// Set opening balance (button or Return in either field).
    public func submitOpeningBalance() async {
        guard let draft = opening, draft.canSubmit, let balance = draft.parsedBalance, let date = draft.date else {
            return
        }
        opening?.isSaving = true
        let saved = await stampOpeningBalance(
            id: draft.accountId, balance: balance, date: date.ymd, currency: draft.currency)
        if saved {
            if opening?.accountId == draft.accountId { opening = nil }
            await refreshAfterWrite()
        } else {
            opening?.isSaving = false
        }
    }

    // MARK: Merge

    public func openMerge(_ account: OpenAPI.Account) {
        merge = MergeDraft(source: account)
    }

    public func closeMerge() {
        merge = nil
    }

    /// Every other account, archived ones included (suffixed in the view).
    public var mergeCandidates: [OpenAPI.Account] {
        guard let merge else { return [] }
        return (accounts ?? []).filter { $0.id != merge.source.id }
    }

    /// The survivor select: the preview of the new pair loads.
    public func selectMergeTarget(_ id: AccountID) async {
        guard merge != nil else { return }
        merge?.selectTarget(id)
        await loadMergePreview()
    }

    /// The preview's Retry: the acknowledgement clears.
    public func retryMergePreview() async {
        guard merge?.targetId != nil else { return }
        merge?.clearAcknowledgement()
        merge?.preview = .loading
        await loadMergePreview()
    }

    private func loadMergePreview() async {
        guard let draft = merge, let target = draft.targetId else { return }
        let source = draft.source.id
        do {
            let preview = try await service.mergePreview(sourceId: source, targetId: target)
            guard merge?.source.id == source, merge?.targetId == target else { return }
            merge?.preview = .loaded(preview)
        } catch {
            guard merge?.source.id == source, merge?.targetId == target else { return }
            merge?.preview = .failed
        }
    }

    public func setMergeAcknowledged(_ value: Bool) {
        guard merge?.canAcknowledge == true || !value else { return }
        merge?.setAcknowledged(value)
    }

    /// The preview's summary line.
    public func mergeSummary(_ preview: AccountMergePreview, target: OpenAPI.Account) -> String {
        let currency = preview.projectedBalanceCurrency ?? target.currency
        return t(
            "accounts.mergePreview.summary",
            [
                "transactions": count(preview.transactions), "planned": count(preview.planned),
                "balance": money(preview.projectedBalance, currency: currency),
            ])
    }

    /// Merge: `POST /api/accounts/:targetId/merge`, with the receipt toast.
    public func confirmMerge() async {
        guard let draft = merge, draft.canMerge, let target = draft.targetId else { return }
        merge?.isMerging = true
        do {
            let counts = try await service.merge(targetId: target, sourceIds: [draft.source.id])
            post(
                .success, "accounts.merged",
                detail: t(
                    "accounts.mergedReceipt",
                    ["transactions": String(counts.transactions), "planned": String(counts.planned)]))
            merge = nil
            await refreshAfterWrite()
        } catch {
            merge?.isMerging = false
            post(.error, "accounts.mergeFailedTitle", detail: errorText(error))
        }
    }

    // MARK: Close account

    /// Close account (and the 409 route from Delete): the lot preview and the broker
    /// destinations load for a portfolio-type account.
    public func openClose(_ account: OpenAPI.Account) async {
        close = CloseDraft(account: account)
        guard AccountKinds.isPortfolio(account) else { return }
        let id = account.id
        let service = service
        async let brokers = try? service.accounts(active: "true")
        let preview: AccountLoad<AccountLotPreview>
        do {
            preview = .loaded(try await service.lotPreview(accountId: id))
        } catch {
            preview = .failed
        }
        let list = await brokers
        guard close?.account.id == id else { return }
        close?.lotPreview = preview
        close?.brokers = AccountKinds.activeBrokers(list ?? [])
    }

    public func closeCloseDialog() {
        close = nil
    }

    /// The lot destination select.
    public func setCloseLotChoice(_ choice: LotDestination) {
        close?.lotChoice = choice
    }

    /// `accounts.close.residual`'s `{balance}`.
    public func residualLabel(_ draft: CloseDraft) -> String {
        draft.residualParts.map { money($0.balance, currency: $0.currency) }.joined(separator: ", ")
    }

    /// Close account: moves the lots when asked (one idempotency key per move, reused on a
    /// retry), then `POST /api/accounts/:id/close`.
    public func confirmClose() async {
        guard let draft = close, draft.canClose else { return }
        let account = draft.account
        close?.isClosing = true
        var moved = 0
        do {
            if draft.shouldRetag {
                guard let preview = draft.lotPreview?.value, preview.isComplete else {
                    throw AccountFlowError(message: t("accounts.close.portfolioUnavailable"))
                }
                let destination = draft.lotChoice.toAccountId
                let key = moveKey(draft.moveKey, ids: preview.transactionIds, from: account.id, to: destination)
                close?.moveKey = key
                let receipt = try await service.retagLots(
                    LotRetagRequest(
                        transactionIds: preview.transactionIds, fromAccountId: account.id, toAccountId: destination,
                        idempotencyKey: key.key))
                moved = receipt.movedCount
            }
            try await service.closeAccount(id: account.id, balanceHandling: draft.balanceHandling)
            post(
                .success, "accounts.close.done", ["name": AccountKinds.label(account)],
                detail: moved > 0 ? t("accounts.close.portfolioMoved", ["count": String(moved)]) : nil)
            close = nil
            await refreshAfterWrite()
        } catch {
            close?.isClosing = false
            if moved > 0 {
                post(
                    .error, "accounts.close.portfolioPartial",
                    detail: t("accounts.close.portfolioPartialHint", ["count": String(moved)]))
                await refreshAfterWrite()
            } else {
                post(.error, "accounts.close.failed", detail: errorText(error))
            }
        }
    }

    /// The key of this exact move: kept while the fingerprint is unchanged.
    private func moveKey(
        _ current: LotMoveKey?, ids: [TransactionID], from accountId: AccountID, to destination: AccountID?
    ) -> LotMoveKey {
        let fingerprint = LotMoveKey.fingerprint(ids: ids, from: accountId, to: destination)
        if let current, current.fingerprint == fingerprint { return current }
        return LotMoveKey(fingerprint: fingerprint, key: makeKey())
    }

    // MARK: Transfer portfolio lots

    public func openTransfer(_ account: OpenAPI.Account) async {
        transfer = BrokerTransferDraft(account: account)
        let preview = Task { [weak self] in
            guard let self else { return }
            await self.loadTransferPreview()
        }
        await loadTransferAccounts()
        await preview.value
    }

    public func closeTransfer() {
        transfer = nil
    }

    /// The preview error's Retry.
    public func loadTransferPreview() async {
        guard let id = transfer?.account.id else { return }
        transfer?.preview = .loading
        let result: AccountLoad<AccountLotPreview>
        do {
            result = .loaded(try await service.lotPreview(accountId: id))
        } catch {
            result = .failed
        }
        guard transfer?.account.id == id else { return }
        transfer?.preview = result
    }

    /// The destination error's Retry.
    public func loadTransferAccounts() async {
        guard let id = transfer?.account.id else { return }
        transfer?.accounts = .loading
        let result: AccountLoad<[OpenAPI.Account]>
        do {
            result = .loaded(AccountKinds.activeBrokers(try await service.accounts(active: "true")))
        } catch {
            result = .failed
        }
        guard transfer?.account.id == id else { return }
        transfer?.accounts = result
    }

    public func setTransferDestination(_ destination: LotDestination) {
        transfer?.destination = destination
    }

    /// Transfer lots: `PUT /api/investments/transactions/broker`, then the receipt.
    public func confirmTransfer() async {
        guard let draft = transfer, draft.canTransfer, let destination = draft.destination,
            let preview = draft.preview.value
        else { return }
        let account = draft.account
        transfer?.isTransferring = true
        defer { if transfer?.account.id == account.id { transfer?.isTransferring = false } }
        do {
            guard preview.isComplete else {
                throw AccountFlowError(message: t("portfolio.brokerTransfer.unavailable"))
            }
            let target = destination.toAccountId
            let key = moveKey(draft.moveKey, ids: preview.transactionIds, from: account.id, to: target)
            transfer?.moveKey = key
            let receipt = try await service.retagLots(
                LotRetagRequest(
                    transactionIds: preview.transactionIds, fromAccountId: account.id, toAccountId: target,
                    idempotencyKey: key.key))
            transfer?.receipt = receipt
            post(
                .success, "portfolio.brokerTransfer.done",
                detail: t("portfolio.brokerTransfer.doneHint", ["count": String(receipt.movedCount)]))
            await refreshAfterWrite()
        } catch {
            post(.error, "portfolio.brokerTransfer.failed", detail: errorText(error))
        }
    }

    // MARK: Reopen and delete

    /// Reopen: `PATCH { is_active: true }` (it does not restore `in_net_worth`).
    public func reopen(_ account: OpenAPI.Account) async {
        guard !isReopening else { return }
        isReopening = true
        defer { isReopening = false }
        do {
            try await service.updateAccount(id: account.id, patch: .reopen)
            post(.success, "accounts.updated")
            await refreshAfterWrite()
        } catch {
            post(.error, "accounts.updateFailedTitle", detail: errorText(error))
        }
    }

    /// Delete: asks first.
    public func requestDelete(_ account: OpenAPI.Account) {
        pendingDelete = account
    }

    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's title, message and button.
    public func deleteText() -> (title: String, message: String, action: String)? {
        guard let pendingDelete else { return nil }
        return (
            t("accounts.delete.title"),
            t("accounts.delete.description", ["name": AccountKinds.label(pendingDelete)]),
            t("common.delete")
        )
    }

    /// The alert's Delete: `DELETE /api/accounts/:id`, then the hub. A 409 (still
    /// referenced) opens Close account instead.
    public func confirmDelete() async {
        guard let account = pendingDelete, !isDeleting else { return }
        pendingDelete = nil
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await service.deleteAccount(id: account.id)
            post(.success, "accounts.deleted")
            navigate(to: AccountsRoutes.path)
            await refreshAfterWrite()
        } catch {
            if case .client(let failure) = APIError.wrapping(error), failure.status == 409 {
                post(.info, "accounts.delete.stillReferenced", ["name": AccountKinds.label(account)])
                await openClose(account)
                return
            }
            post(.error, "accounts.deleteFailedTitle", detail: errorText(error))
        }
    }
}
