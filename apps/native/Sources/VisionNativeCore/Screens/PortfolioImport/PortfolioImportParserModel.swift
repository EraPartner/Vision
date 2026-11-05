import Foundation
import Observation

@MainActor @Observable
public final class PortfolioImportParserModel {
    public private(set) var source = "auto"
    public private(set) var file: PortfolioImportFile?
    public var config = PortfolioImportConfig() {
        didSet {
            if !suppressProbe
                && (config.separator != oldValue.separator || config.encoding != oldValue.encoding
                    || config.skipRows != oldValue.skipRows)
            {
                queueProbe()
            }
        }
    }
    public var parserName = ""
    public private(set) var savedParsers: [PortfolioImportParser] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var probe: PortfolioImportProbe?
    public private(set) var detected: PortfolioImportDetected?
    public private(set) var isDetecting = false
    public private(set) var detectionFailed = false
    public private(set) var isBusy = false
    public private(set) var progress: ImportProgress?
    public private(set) var error: String?
    public private(set) var notice: String?
    public private(set) var outcome: PortfolioImportOutcome?
    public private(set) var outcomeUncertain = false
    public var rawHeaders: [String] { probe?.preview?.headers ?? [] }
    public var sampleRows: [[String]] { probe?.preview?.rows ?? [] }
    public var typeValues: [String] {
        guard let index = rawHeaders.firstIndex(of: config.typeColumn) else { return [] }
        var values: [String] = []
        for row in sampleRows {
            let value = (row.indices.contains(index) ? row[index] : "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty && !values.contains(value) { values.append(value) }
        }
        return values
    }
    public var brokerAccounts: [OpenAPI.Account] { portfolioImportBrokerAccounts(accounts) }
    public var selectedParser: PortfolioImportParser? {
        source.hasPrefix("saved:") ? savedParsers.first { $0.id == PortfolioParserConfigID(String(source.dropFirst(6))) } : nil
    }
    public var parserDirty: Bool { parserName != baselineName || config != baselineConfig }
    public var isDirty: Bool { file != nil || parserDirty }
    public var canImport: Bool {
        file != nil && config.hasRequiredMapping && !isBusy && !isDetecting && !detectionFailed && !outcomeUncertain
            && (!config.isSpecialized || brokerAccounts.contains { $0.id == config.accountId })
    }
    public var canSave: Bool {
        !isBusy && !parserName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && config.hasRequiredMapping
            && (!config.isSpecialized || brokerAccounts.contains { $0.id == config.accountId })
    }
    public var didImport: (@MainActor (PortfolioImportOutcome) -> Void)?
    public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any PortfolioImportService
    @ObservationIgnored private var baselineName = ""
    @ObservationIgnored private var baselineConfig = PortfolioImportConfig()
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var loadRevision = UUID()
    @ObservationIgnored private var probeTask: Task<Void, Never>?
    @ObservationIgnored private var uploadTask: Task<PortfolioImportOutcome, Error>?
    @ObservationIgnored private var accountChosenManually = false
    @ObservationIgnored private var suppressProbe = false
    @ObservationIgnored private var navigationRevision = UUID()
    @ObservationIgnored private var recoveryVerified = false
    public init(service: any PortfolioImportService) { self.service = service }

    public func load() async {
        let generation = UUID()
        loadRevision = generation
        async let parserResult = Self.result { try await self.service.importParsers() }
        async let accountResult = Self.result { try await self.service.importAccounts() }
        let (parsers, accounts) = await (parserResult, accountResult)
        guard generation == loadRevision else { return }
        switch parsers {
        case .success(let value): savedParsers = value
        case .failure(let failure): error = failure.localizedDescription
        }
        switch accounts {
        case .success(let value):
            self.accounts = value
            applyDetectedAccount()
        case .failure(let failure): error = failure.localizedDescription
        }
    }
    public func selectFile(_ next: PortfolioImportFile?) async {
        guard !isBusy else { return }
        revision = UUID()
        probeTask?.cancel()
        file = next
        probe = nil
        detected = nil
        progress = nil
        outcome = nil
        error = nil
        notice = nil
        detectionFailed = false
        outcomeUncertain = false
        recoveryVerified = false
        accountChosenManually = false
        suppressProbe = true
        if source == "auto" { config = PortfolioImportConfig() }
        suppressProbe = false
        await refreshProbe(applyDetection: true)
    }
    public func selectSource(_ next: String) async {
        guard !isBusy else { return }
        revision = UUID()
        probeTask?.cancel()
        source = next
        detected = nil
        progress = nil
        error = nil
        detectionFailed = false
        accountChosenManually = false
        suppressProbe = true
        if let parser = selectedParser {
            config = parser.config
            parserName = parser.name
        } else {
            config = PortfolioImportConfig.preset(next) ?? PortfolioImportConfig()
            parserName = ""
        }
        baselineName = parserName
        baselineConfig = config
        suppressProbe = false
        await refreshProbe(applyDetection: true)
    }
    public func setAccount(_ id: AccountID?) {
        guard !isBusy else { return }
        accountChosenManually = true
        config.accountId = id
    }
    private func applyDetectedAccount() {
        guard source == "auto", !accountChosenManually, let detected else { return }
        config.accountId = detected.resolveAccount(accounts)
    }
    private func queueProbe() {
        guard file != nil, !isBusy else { return }
        probeTask?.cancel()
        revision = UUID()
        probe = nil
        probeTask = Task { [weak self] in await self?.readProbe(applyDetection: false) }
    }
    public func refreshProbe(applyDetection: Bool = false) async {
        probeTask?.cancel()
        revision = UUID()
        await readProbe(applyDetection: applyDetection)
    }
    private func readProbe(applyDetection: Bool) async {
        guard !Task.isCancelled, let file else {
            isDetecting = false
            return
        }
        let current = revision
        let submitted = config
        probe = nil
        isDetecting = true
        defer { if current == revision { isDetecting = false } }
        do {
            let value = try await service.importProbe(file: file, config: submitted)
            guard current == revision, self.file?.id == file.id, !Task.isCancelled else { return }
            probe = value
            if source == "auto" && applyDetection {
                detected = value.detected
                detectionFailed =
                    value.detectionError != nil
                    || (file.filename.lowercased().hasSuffix(".xls") || file.filename.lowercased().hasSuffix(".xlsx"))
                        && value.detected == nil
                if let detected, let preset = PortfolioImportConfig.preset(detected.presetKey?.rawValue ?? detected.source.rawValue) {
                    let account = config.accountId
                    config = preset
                    if accountChosenManually {
                        config.accountId = account
                    } else {
                        config.accountId = detected.resolveAccount(accounts)
                    }
                }
            }
        } catch {
            guard current == revision, !Task.isCancelled else { return }
            probe = nil
            detectionFailed = source == "auto"
            self.error = error.localizedDescription
        }
    }
    public func saveParser() async {
        guard canSave else { return }
        isBusy = true
        error = nil
        notice = nil
        let submitted = config
        let name = parserName.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = selectedParser?.id
        defer { isBusy = false }
        do {
            let saved = try await service.importSaveParser(id: selected, name: name, config: submitted)
            guard saved.config == submitted, saved.name == name, selected == nil || saved.id == selected else {
                throw PortfolioImportFailure.unverified("Parser acknowledgement does not match the submitted mapping")
            }
            savedParsers.removeAll { $0.id == saved.id }
            savedParsers.append(saved)
            source = "saved:\(saved.id)"
            baselineName = name
            baselineConfig = submitted
            if parserName.trimmingCharacters(in: .whitespacesAndNewlines) == name { parserName = name }
            notice = "importPage.customParser.saved"
        } catch {
            self.error = error.localizedDescription
            await reloadParsersAfterFailure()
        }
    }
    public func deleteParser() async {
        guard !isBusy, let id = selectedParser?.id else { return }
        isBusy = true
        error = nil
        defer { isBusy = false }
        do {
            try await service.importDeleteParser(id: id)
            savedParsers.removeAll { $0.id == id }
            source = "custom"
            config = PortfolioImportConfig()
            parserName = ""
            baselineName = ""
            baselineConfig = config
        } catch {
            self.error = error.localizedDescription
            await reloadParsersAfterFailure()
        }
    }
    private func reloadParsersAfterFailure() async {
        if let authoritative = try? await service.importParsers() { savedParsers = authoritative }
    }
    public func importFile() async {
        guard canImport, let file else { return }
        isBusy = true
        error = nil
        notice = nil
        outcome = nil
        progress = .connecting
        let submitted = config
        let submittedNavigation = navigationRevision
        let adapter =
            submitted.format?.rawValue
            ?? selectedParser?.name
            ?? (parserName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "portfolio_generic" : parserName.trimmingCharacters(in: .whitespacesAndNewlines))
        let task = Task {
            try await service.importStream(file: file, config: submitted, adapterName: adapter) {
                [weak self] progress in await self?.receive(progress)
            }
        }
        uploadTask = task
        defer {
            uploadTask = nil
            isBusy = false
        }
        do {
            let result = try await task.value
            outcome = result
            outcomeUncertain = false
            if !result.requiresReview {
                self.file = nil
                progress = ImportProgress(phase: "complete", percent: 100)
            }
            notice = result.requiresReview ? nil : "portfolioImport.toast.importSuccess"
            if submittedNavigation == navigationRevision { didImport?(result) }
        } catch is CancellationError {
            notice = "importPage.toast.importCancelled"
            outcomeUncertain = true
            progress = nil
            recoveryVerified = (try? await service.importBatches(limit: 50, offset: 0)) != nil
        } catch {
            self.error = error.localizedDescription
            outcomeUncertain = true
            progress = nil
            recoveryVerified = (try? await service.importBatches(limit: 50, offset: 0)) != nil
        }
        await didMutate?()
    }
    private func receive(_ progress: ImportProgress) {
        guard isBusy else { return }
        self.progress = progress
    }
    public func cancel() { uploadTask?.cancel() }
    public func discardDrafts() {
        navigationRevision = UUID()
        revision = UUID()
        probeTask?.cancel()
        uploadTask?.cancel()
        file = nil
        probe = nil
        detected = nil
        progress = nil
        outcome = nil
        parserName = baselineName
        suppressProbe = true
        config = baselineConfig
        suppressProbe = false
        isDetecting = false
    }
    public func invalidateReadSources() {
        loadRevision = UUID()
        Task { [weak self] in await self?.load() }
    }
    public func acknowledgeUncertainOutcome() {
        guard !isBusy, recoveryVerified else { return }
        outcomeUncertain = false
    }
    @discardableResult public func recoverUncertainOutcome() async -> Bool {
        guard !isBusy, outcomeUncertain else { return !outcomeUncertain }
        do {
            _ = try await service.importBatches(limit: 50, offset: 0)
            recoveryVerified = true
            outcomeUncertain = false
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
    private static func result<T: Sendable>(_ operation: () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await operation()) } catch { return .failure(error) }
    }
}
