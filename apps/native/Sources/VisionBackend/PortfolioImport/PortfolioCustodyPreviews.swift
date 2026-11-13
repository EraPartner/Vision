import Foundation
import VisionNativeCore

/// Why a staged row cannot be planned (`PlanIssue.reason`): the reconciliation plan's own
/// reasons, the cross-format rules' and the custody previews' errors.
enum ReconciliationBlockReason: String, Sendable, Hashable {
    // Reconciliation plan
    case incompleteSource = "incomplete_source"
    case invalidInternalAnnotation = "invalid_internal_annotation"
    case missingCompanionProHistory = "missing_companion_pro_history"
    case invalidSourceValues = "invalid_source_values"
    case pairedIncomeUnitsMissing = "paired_income_units_missing"
    case pairedIncomeExistingConflict = "paired_income_existing_conflict"
    case sourceIdentityConflict = "source_identity_conflict"
    case sourcePolicyConflict = "source_policy_conflict"
    case sourcePolicyRequired = "source_policy_required"
    case ambiguousHistory = "ambiguous_history"
    case unprovenEconomics = "unproven_economics"
    case unprovenCurrencyConversion = "unproven_currency_conversion"
    case unprovenUnits = "unproven_units"
    case missingOriginalBasis = "missing_original_basis"
    case missingSourceIdentity = "missing_source_identity"
    case existingAssignedOrImportedHistory = "existing_assigned_or_imported_history"
    // Cross-format rules
    case crossFormatSourceConflict = "cross_format_source_conflict"
    case crossFormatIdentityMissing = "cross_format_identity_missing"
    case crossFormatIdentityAmbiguous = "cross_format_identity_ambiguous"
    case ambiguousFundingHistory = "ambiguous_funding_history"
    case fundingDateMismatch = "funding_date_mismatch"
    case fundingDateAmbiguous = "funding_date_ambiguous"
    case ambiguousCashHistory = "ambiguous_cash_history"
    // Asset transfer preview
    case unresolvedTransferDirection = "unresolved_transfer_direction"
    case unresolvedTransferOrigin = "unresolved_transfer_origin"
    case unresolvedTransferDestination = "unresolved_transfer_destination"
    case incompleteTransfer = "incomplete_transfer"
    case unresolvedTransferFeeBasis = "unresolved_transfer_fee_basis"
    case missingTransferIdentity = "missing_transfer_identity"
    // Asset adjustment preview
    case unresolvedAdjustmentKind = "unresolved_adjustment_kind"
    case unresolvedZeroYieldPolicy = "unresolved_zero_yield_policy"
    case unresolvedAdjustmentBasis = "unresolved_adjustment_basis"
    case incompleteAdjustment = "incomplete_adjustment"
    case missingAdjustmentIdentity = "missing_adjustment_identity"
}

/// A custody preview: the event a staged row would write, or why it cannot.
enum CustodyPreview<Event: Sendable>: Sendable {
    case event(Event)
    case error(ReconciliationBlockReason)
}

/// A previewed `portfolio_asset_transfers` event (`AssetTransferEvent`); the fields the
/// reconciliation plan reads.
struct AssetTransferEvent: Equatable, Sendable {
    let investmentID: InvestmentID
    let sourceAccountID: AccountID
    let destinationAccountID: AccountID
    let day: String
    let units: String
    let feeUnits: String
    let dedupFingerprint: String
    let dedupFingerprintVersion: Int
}

/// A previewed `portfolio_asset_adjustments` event (`AssetAdjustmentEvent`); the fields the
/// reconciliation plan reads. The eligible yield source hashes commit derives are not part
/// of the plan and are not computed here.
struct AssetAdjustmentEvent: Equatable, Sendable {
    enum Kind: String, Sendable {
        case yieldReversal = "yield_reversal"
        case assetFee = "asset_fee"
    }

    enum BasisPolicy: String, Sendable {
        case zeroYieldOnly = "zero_yield_only"
        case carried
    }

    let accountID: AccountID
    let investmentID: InvestmentID
    let day: String
    let units: String
    let kind: Kind
    let basisPolicy: BasisPolicy
    let dedupFingerprint: String
    let dedupFingerprintVersion: Int
}

/// The pure custody previews of `services/portfolio/portfolioAssetTransferService.ts` and
/// `portfolioAssetAdjustmentService.ts`, as the reconciliation plan calls them: with the
/// staged row alone, so the batch's account and configuration are the row's own.
enum PortfolioCustodyPreviews {
    private enum TransferDirection: String {
        case incoming = "in"
        case outgoing = "out"
    }

    private static let carriedBasis = "carried"
    private static let zeroYieldPolicy = "zero"

    /// `Number(value)` where an absent key is `undefined` (`NaN`).
    private static func number(_ value: JSValue?) -> Double {
        value?.javaScriptNumber ?? .nan
    }

    /// `Number(row.user_override_investment_id ?? row.resolved_investment_id ?? row.investment_id)`.
    private static func investment(_ row: ReconciliationSourceRow) -> InvestmentID? {
        guard let id = row.userOverrideInvestmentID ?? row.resolvedInvestmentID ?? row.investmentID, id.rawValue > 0
        else { return nil }
        return id
    }

    /// `toDecimal(row.units === "" ? 0 : (row.units ?? 0)).gt(0)` with a transaction date.
    private static func datedPositiveUnits(_ row: ReconciliationSourceRow) throws -> (day: String, units: String)? {
        guard let day = row.day, !day.isEmpty, let units = row.units, try DecimalJS.from(units).gt(.zero) else {
            return nil
        }
        return (String(day.prefix(10)), units)
    }

    private static func identity(_ row: ReconciliationSourceRow) -> (fingerprint: String, version: Int)? {
        guard let hash = row.sourceRecordHash, !hash.isEmpty, let fingerprint = row.dedupFingerprint,
            !fingerprint.isEmpty, let version = row.dedupFingerprintVersion, version != 0
        else { return nil }
        return (fingerprint, version)
    }

    /// `previewPortfolioAssetTransfer(row)`.
    static func assetTransfer(_ row: ReconciliationSourceRow) throws -> CustodyPreview<AssetTransferEvent> {
        let config = row.customConfig?.parsedObject ?? JSObject()
        guard let details = row.assetTransferDetails,
            let direction = details["direction"]?.stringValue.flatMap(TransferDirection.init(rawValue:))
        else { return .error(.unresolvedTransferDirection) }
        let incoming = direction == .incoming
        let ownAccount = Double(row.accountID?.rawValue ?? 0)
        // `details.networkBinding?.originAccountId ?? config.transfer_origin_account_id`
        var origin = details["networkBinding"]?.objectValue?["originAccountId"]
        if origin == nil || origin == .null { origin = config["transfer_origin_account_id"] }
        let source = incoming ? number(origin) : ownAccount
        let destination = incoming ? ownAccount : number(config["transfer_destination_account_id"])
        guard let sourceAccount = ImportInterop.positiveInteger(source),
            let destinationAccount = ImportInterop.positiveInteger(destination), sourceAccount != destinationAccount
        else { return .error(incoming ? .unresolvedTransferOrigin : .unresolvedTransferDestination) }
        guard let investmentID = investment(row), let dated = try datedPositiveUnits(row) else {
            return .error(.incompleteTransfer)
        }
        // `details.feeUnits === "" ? 0 : (details.feeUnits ?? 0)`
        var feeValue = details["feeUnits"] ?? .number(0)
        if feeValue == .null || feeValue == .string("") { feeValue = .number(0) }
        let fee = try ImportInterop.decimal(feeValue)
        guard details["basisStatus"]?.stringValue == carriedBasis, !fee.lt(.zero),
            !fee.gte(try DecimalJS.from(dated.units))
        else { return .error(.unresolvedTransferFeeBasis) }
        guard let identity = identity(row) else { return .error(.missingTransferIdentity) }
        return .event(
            AssetTransferEvent(
                investmentID: investmentID, sourceAccountID: AccountID(rawValue: sourceAccount),
                destinationAccountID: AccountID(rawValue: destinationAccount), day: dated.day, units: dated.units,
                feeUnits: feeValue.javaScriptString, dedupFingerprint: identity.fingerprint,
                dedupFingerprintVersion: identity.version))
    }

    /// `previewPortfolioAssetAdjustment(row, undefined, { sourceRows })`.
    static func assetAdjustment(_ row: ReconciliationSourceRow) throws -> CustodyPreview<AssetAdjustmentEvent> {
        guard let details = row.assetAdjustmentDetails,
            let kind = details["kind"]?.stringValue.flatMap(AssetAdjustmentEvent.Kind.init(rawValue:))
        else { return .error(.unresolvedAdjustmentKind) }
        let reversal = kind == .yieldReversal
        let config = row.customConfig?.parsedObject ?? JSObject()
        if reversal, config["yield_basis_policy"]?.stringValue != zeroYieldPolicy {
            return .error(.unresolvedZeroYieldPolicy)
        }
        let expectedPolicy: AssetAdjustmentEvent.BasisPolicy = reversal ? .zeroYieldOnly : .carried
        guard details["basisPolicy"]?.stringValue == expectedPolicy.rawValue else {
            return .error(.unresolvedAdjustmentBasis)
        }
        // `Number(details.accountId ?? row.account_id)`
        var accountValue = details["accountId"]
        if accountValue == nil || accountValue == .null { accountValue = .number(Double(row.accountID?.rawValue ?? 0)) }
        guard let account = ImportInterop.positiveInteger(number(accountValue)), let investmentID = investment(row),
            let dated = try datedPositiveUnits(row)
        else { return .error(.incompleteAdjustment) }
        guard let identity = identity(row) else { return .error(.missingAdjustmentIdentity) }
        return .event(
            AssetAdjustmentEvent(
                accountID: AccountID(rawValue: account), investmentID: investmentID, day: dated.day,
                units: dated.units, kind: kind, basisPolicy: expectedPolicy, dedupFingerprint: identity.fingerprint,
                dedupFingerprintVersion: identity.version))
    }
}
