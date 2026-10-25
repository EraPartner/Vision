import Foundation
import Observation

@MainActor @Observable
public final class TaxDeductionsModel {
    public static let dismissalStorageKey = "dismissed_deduction_candidates_v1"
    public private(set) var data: TaxDeductionCandidates?
    public private(set) var error: String?
    public private(set) var applyError: String?
    public private(set) var isFetching = false
    public private(set) var isApplying = false
    public private(set) var appliedTypes: Set<String> = []
    public var pending: TaxDeductionGroup?
    public var canConfirm: Bool { data != nil && fetchedAt != nil && error == nil && !isFetching && !isApplying }
    public var groups: [TaxDeductionGroup] {
        guard let data else { return [] }
        return data.byDeductionType.filter { group in
            group.mapping != nil && group.total > 0
                && !dismissed.contains { $0.year == data.year && $0.deductionType == group.deductionType }
        }
    }
    @ObservationIgnored private let service: any TaxDeductionsService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var readStorage: (@Sendable (String) async -> String?)?
    @ObservationIgnored private var writeStorage: (@Sendable (String, String) async -> Void)?
    private var dismissed: [Dismissal] = []
    @ObservationIgnored private var storageLoaded = false
    @ObservationIgnored private var requestedYear: Int?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    private struct Dismissal: Codable, Equatable, Sendable {
        let year: Int
        let deductionType: String
    }

    public init(service: any TaxDeductionsService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public func bindStorage(
        read: @escaping @Sendable (String) async -> String?, write: @escaping @Sendable (String, String) async -> Void
    ) {
        readStorage = read
        writeStorage = write
    }
    public func invalidate() {
        revision = UUID()
        task?.cancel()
        task = nil
        fetchedAt = nil
        isFetching = false
        pending = nil
    }
    public func load(year: Int, force: Bool = false) async {
        if requestedYear != year {
            invalidate()
            data = nil
            error = nil
            applyError = nil
            appliedTypes = []
            requestedYear = year
        }
        if !storageLoaded {
            if let raw = await readStorage?(Self.dismissalStorageKey), let bytes = raw.data(using: .utf8),
                let rows = try? JSONDecoder().decode([TaxValue].self, from: bytes)
            {
                dismissed = rows.compactMap { row in
                    guard let year = row["year"]?.decimalValue, let type = row["deductionType"]?.stringValue else {
                        return nil
                    }
                    let integer = NSDecimalNumber(decimal: year).intValue
                    guard Decimal(integer) == year else { return nil }
                    return Dismissal(year: integer, deductionType: type)
                }
            }
            storageLoaded = true
        }
        guard requestedYear == year else { return }
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 300 { return }
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        isFetching = true
        pending = nil
        let request = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await service.deductionCandidates(year: year)
                guard token == revision, !Task.isCancelled else { return }
                guard result.year == year else { throw APIError.invalidRequest("Wrong deduction candidate year") }
                data = result
                error = nil
                fetchedAt = now()
            } catch {
                guard token == revision, !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
        task = request
        await request.value
        guard token == revision else { return }
        task = nil
        isFetching = false
    }
    public func retry() async {
        if let year = requestedYear { await load(year: year, force: true) }
    }
    public func needsAcknowledgement() -> Bool {
        guard let year = data?.year else { return false }
        return Calendar.current.component(.year, from: now()) == year
    }
    public func dismiss(_ group: TaxDeductionGroup) async {
        guard let year = data?.year else { return }
        let item = Dismissal(year: year, deductionType: group.deductionType)
        if !dismissed.contains(item) { dismissed.append(item) }
        if let bytes = try? APIBody.encode(dismissed) {
            await writeStorage?(Self.dismissalStorageKey, String(decoding: bytes, as: UTF8.self))
        }
    }
    @discardableResult public func apply(
        _ group: TaxDeductionGroup, perform: (TaxDeductionApplication) async throws -> Bool
    ) async -> Bool {
        guard canConfirm, let data, groups.contains(group), !appliedTypes.contains(group.deductionType) else {
            return false
        }
        let token = revision
        isApplying = true
        applyError = nil
        pending = nil
        defer { isApplying = false }
        do {
            guard try await perform(.init(year: data.year, group: group)) else { return false }
            guard token == revision else { return false }
            appliedTypes.insert(group.deductionType)
            return true
        } catch {
            applyError = error.localizedDescription
            return false
        }
    }
}
