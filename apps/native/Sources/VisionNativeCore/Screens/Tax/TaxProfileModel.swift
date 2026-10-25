import Foundation
import Observation

@MainActor
@Observable
public final class TaxProfileModel {
    public private(set) var draft = TaxProfileDraft(value: .object([:]))
    public var step: TaxProfileStep = .household
    public var selectedPartner = "A"
    public var categorySearch = ""
    public private(set) var isPresented = false
    public private(set) var isSaving = false
    public private(set) var hasPendingChanges = false
    public private(set) var error: String?
    public private(set) var validationErrorKey: String?
    public private(set) var preview: OpenAPI.BelgianTaxComputation?
    public private(set) var previewError: String?
    public private(set) var isComputing = false
    public private(set) var categories: [OpenAPI.CategoryNode] = []
    public private(set) var categoriesLoading = false
    public private(set) var categoriesError: String?
    public private(set) var year = 0
    public private(set) var editingHistorical = false
    public private(set) var isFiled = false
    public private(set) var filedOverride = false
    public var isLocked: Bool { isFiled && !filedOverride }
    public var partner: String {
        draft.partners.contains { $0["id"]?.stringValue == selectedPartner } ? selectedPartner : "A"
    }
    public var assessment: OpenAPI.BelgianTaxAssessmentDecision? {
        preview?.result.assessment ?? (draft.value == initialValue ? initial?.result.assessment : nil)
    }

    @ObservationIgnored private let service: any TaxComputationService
    @ObservationIgnored private let settings: any TaxSettingsService
    @ObservationIgnored private let overviewModel: TaxOverviewModel
    @ObservationIgnored private let categoryService: (any CategoriesService)?
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var initial: OpenAPI.BelgianTaxOverview?
    @ObservationIgnored private var records: [OpenAPI.Setting] = []
    @ObservationIgnored private var live: TaxValue = .object([:])
    @ObservationIgnored private var snapshots: TaxValue = .object([:])
    @ObservationIgnored private var metadata: TaxValue = .object([:])
    @ObservationIgnored private var committed: TaxValue = .object([:])
    @ObservationIgnored private var initialValue: TaxValue = .object([:])
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Bool, Never>?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()

    public init(
        service: any TaxComputationService, settings: any TaxSettingsService, overview: TaxOverviewModel,
        categories: (any CategoriesService)? = nil, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.settings = settings
        self.overviewModel = overview
        self.categoryService = categories ?? (service as? any CategoriesService)
        self.now = now
    }
    public func begin(overview: OpenAPI.BelgianTaxOverview, initialStep: TaxProfileStep = .household) {
        guard !isPresented, !isSaving else { return }
        do {
            let invalid = Set(overview.warnings.filter { $0.kind == .invalidStored }.map(\.key))
            live = try seed(
                TaxYearMutation.householdKey, fallback: TaxValue(encoding: overview.liveHousehold),
                records: overview.records, replaceInvalid: invalid.contains(TaxYearMutation.householdKey))
            snapshots = try seed(
                TaxYearMutation.snapshotsKey, fallback: TaxValue(encoding: overview.householdSnapshots),
                records: overview.records, replaceInvalid: invalid.contains(TaxYearMutation.snapshotsKey))
            metadata = try seed(TaxYearMutation.metadataKey, fallback: .object([:]), records: overview.records)
            year = overview.year
            editingHistorical = overview.year != overview.liveYear && overview.hasSnapshot
            let source = editingHistorical ? snapshots[String(year)] : live
            guard let source, source.objectValue != nil else { throw APIError.invalidRequest("Missing tax household") }
            draft = TaxProfileDraft(value: source)
            committed = source
            initialValue = source
            records = overview.records
            initial = overview
            // TaxProfileDialog: any filed year, the current one included, needs an explicit amend.
            isFiled = metadata[String(year)]?["filing"] != nil && metadata[String(year)]?["filing"] != .null
            filedOverride = false
            step = initialStep
            selectedPartner = "A"
            categorySearch = ""
            hasPendingChanges = false
            error = nil
            validationErrorKey = nil
            preview = nil
            previewError = nil
            revision = UUID()
            isPresented = true
            requestPreview()
        } catch { self.error = error.localizedDescription }
    }
    public func amendFiledYear() { filedOverride = true }
    public func retryPreview() { requestPreview() }
    public func reportActionError(_ message: String?) { error = message }
    /// Parent year actions own unfiling and preserve frozen figures.
    public func didUnfile(overview value: OpenAPI.BelgianTaxOverview? = nil) {
        guard let refreshed = value ?? overviewModel.overview, refreshed.year == year else { return }
        do {
            let refreshedLive = try seed(
                TaxYearMutation.householdKey,
                fallback: TaxValue(encoding: refreshed.liveHousehold), records: refreshed.records)
            let refreshedSnapshots = try seed(
                TaxYearMutation.snapshotsKey,
                fallback: TaxValue(encoding: refreshed.householdSnapshots), records: refreshed.records)
            let refreshedMetadata = try seed(
                TaxYearMutation.metadataKey, fallback: .object([:]), records: refreshed.records)
            let updatedSource = editingHistorical ? refreshedSnapshots[String(year)] : refreshedLive
            guard updatedSource == committed else {
                // Do not accept a newer household baseline while retaining an older form. Pending
                // edits stay available, and their original CAS token still prevents overwriting it.
                throw APIError.invalidRequest(
                    "Tax profile changed while unfiling; your current edits have been retained")
            }
            live = refreshedLive
            snapshots = refreshedSnapshots
            metadata = refreshedMetadata
            records = refreshed.records
            isFiled = metadata[String(year)]?["filing"] != nil && metadata[String(year)]?["filing"] != .null
        } catch { self.error = error.localizedDescription }
    }
    public func edit(_ body: (inout TaxProfileDraft) -> Void) {
        guard isPresented, !isLocked else { return }
        let previous = draft
        body(&draft)
        if editingHistorical { draft.set(["taxYear"], .number(Decimal(year))) }
        guard draft != previous else { return }
        validationErrorKey = nil
        hasPendingChanges = draft.value != committed
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            _ = await self?.flush()
        }
        requestPreview()
    }
    public func go(to target: TaxProfileStep) {
        if target.index > step.index, target.index > TaxProfileStep.income.index, let key = draft.incomeErrorKey {
            step = .income
            validationErrorKey = key
            return
        }
        validationErrorKey = nil
        step = target
    }
    public func back() { if step.index > 0 { go(to: TaxProfileStep.allCases[step.index - 1]) } }
    public func next() async -> Bool {
        if step == .income, let key = draft.incomeErrorKey {
            validationErrorKey = key
            return false
        }
        if step == .region { return await save() }
        go(to: TaxProfileStep.allCases[step.index + 1])
        return false
    }
    /// Save configures the profile; all preceding edits have already been queued for persistence.
    public func save() async -> Bool {
        if !isLocked, let key = draft.incomeErrorKey {
            step = .income
            validationErrorKey = key
            return false
        }
        if !isLocked { edit { $0.set(["profileConfigured"], .bool(true)) } }
        return await close()
    }
    /// Closing keeps edits, including edits waiting for the debounce. A failed save keeps the sheet open.
    public func close() async -> Bool {
        repeat {
            guard await flush() else { return false }
            if hasPendingChanges { await Task.yield() }
        } while hasPendingChanges
        isPresented = false
        debounce?.cancel()
        previewTask?.cancel()
        revision = UUID()
        return true
    }
    @discardableResult public func flush() async -> Bool {
        debounce?.cancel()
        debounce = nil
        if let writeTask { return await writeTask.value }
        guard hasPendingChanges else { return true }
        isSaving = true
        let token = revision
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            do {
                repeat {
                    while hasPendingChanges {
                        let writing = draft.value
                        let patch = try buildPatch(writing)
                        try await settings.saveTaxSettings(patch)
                        guard token == revision else { return false }
                        // Derive the next baseline from the acknowledged write, never from an unrelated
                        // subsequent read that could silently grant permission to overwrite another editor.
                        records = try patch.settings.map { key, value in
                            let json = try JSONDecoder().decode(JSONValue.self, from: APIBody.encode(value))
                            return OpenAPI.Setting(
                                key: key, value: json, expected: .object(["exists": .bool(true), "value": json]))
                        }
                        live = patch.settings[TaxYearMutation.householdKey] ?? live
                        snapshots = patch.settings[TaxYearMutation.snapshotsKey] ?? snapshots
                        metadata = patch.settings[TaxYearMutation.metadataKey] ?? metadata
                        committed = writing
                        hasPendingChanges = draft.value != writing
                        error = nil
                    }
                    await overviewModel.refreshAfterWrite()
                } while hasPendingChanges
                return true
            } catch {
                self.error = error.localizedDescription
                return false
            }
        }
        writeTask = task
        let result = await task.value
        writeTask = nil
        isSaving = false
        return result
    }
    public func loadCategories() async {
        guard let categoryService, !categoriesLoading else { return }
        categoriesLoading = true
        do {
            categories = try await categoryService.categoryTree().filter { $0.isActive }.sorted {
                $0.path.joined(separator: " / ").localizedCaseInsensitiveCompare($1.path.joined(separator: " / "))
                    == .orderedAscending
            }
            categoriesError = nil
        } catch { categoriesError = error.localizedDescription }
        categoriesLoading = false
    }
    private func buildPatch(_ writing: TaxValue) throws -> TaxSettingsPatch {
        var nextLive = live
        var nextSnapshots = snapshots
        var nextMetadata = metadata
        if editingHistorical {
            nextSnapshots[String(year)] = writing
            var meta = nextMetadata[String(year)] ?? .object([:])
            guard meta.objectValue != nil else { throw APIError.invalidRequest("Invalid tax year metadata") }
            var changes: [String: TaxValue] = [:]
            for (key, value) in writing.objectValue ?? [:] where committed[key] != value { changes[key] = value }
            var history = meta["history"]?.arrayValue ?? []
            if let stored = meta["history"], stored.arrayValue == nil {
                throw APIError.invalidRequest("Invalid tax snapshot history")
            }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            history.append(
                .object([
                    "kind": .string("patched"), "at": .string(formatter.string(from: now())),
                    "householdChanges": .object(changes),
                ]))
            meta["history"] = .array(Array(history.suffix(200)))
            nextMetadata[String(year)] = meta
        } else {
            nextLive = writing
        }
        return try TaxSettingsPatch(
            settings: [
                TaxYearMutation.householdKey: nextLive, TaxYearMutation.snapshotsKey: nextSnapshots,
                TaxYearMutation.metadataKey: nextMetadata,
            ], records: records)
    }
    private func requestPreview() {
        previewTask?.cancel()
        preview = nil
        previewError = nil
        isComputing = true
        let token = revision
        let value = draft.value
        previewTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            do {
                let household = try value.decode(OpenAPI.BelgianTaxHouseholdInput.self)
                let result = try await service.computeTax(household: household)
                guard result.result.incomeYear == household.taxYear else {
                    throw APIError.contract(
                        APIContractError(
                            endpoint: "/api/belgian-tax/compute",
                            issues: ["incomeYear: does not match the edited household"]))
                }
                guard !Task.isCancelled, token == revision, draft.value == value else { return }
                preview = result
                previewError = nil
                isComputing = false
            } catch {
                guard !Task.isCancelled, token == revision, draft.value == value else { return }
                previewError = error.localizedDescription
                isComputing = false
            }
        }
    }
    private func seed(_ key: String, fallback: TaxValue, records: [OpenAPI.Setting], replaceInvalid: Bool = false)
        throws -> TaxValue
    {
        if replaceInvalid { return fallback }
        guard let stored = records.first(where: { $0.key == key }), stored.value != .null else { return fallback }
        let raw = try TaxValue(encoding: stored.value)
        guard raw.objectValue != nil else { throw APIError.invalidRequest("\(key): expected object") }
        return Self.merge(raw, canonical: fallback)
    }
    private static func merge(_ raw: TaxValue, canonical: TaxValue) -> TaxValue {
        if var fields = raw.objectValue, let normalized = canonical.objectValue {
            for (key, value) in normalized { fields[key] = merge(fields[key] ?? value, canonical: value) }
            return .object(fields)
        }
        if let rows = canonical.arrayValue, let originals = raw.arrayValue {
            return .array(
                rows.enumerated().map { index, value in
                    let stored =
                        value["id"]?.stringValue.flatMap { id in originals.first { $0["id"]?.stringValue == id } }
                        ?? (originals.indices.contains(index) ? originals[index] : value)
                    return merge(stored, canonical: value)
                })
        }
        return canonical
    }
}
