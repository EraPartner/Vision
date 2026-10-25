import Foundation
import Observation

@MainActor @Observable public final class ResearchForecastModel {
    public var horizonMonths = 60 { didSet { inputsChanged() } }
    public var contributionText = "" { didSet { inputsChanged() } }
    public var targetText = "" { didSet { inputsChanged() } }
    public var returnSource = "historical" { didSet { inputsChanged() } }
    public var blendPct = 50 { didSet { inputsChanged() } }
    public var method = "parametric" { didSet { inputsChanged() } }
    public var paths = 1000 { didSet { inputsChanged() } }
    public private(set) var isFetching = false
    public private(set) var isDebouncing = false
    public private(set) var error: String?
    public private(set) var settings = NativeAppSettings.defaults
    public var currency: String { settings.defaultCurrency.isEmpty ? "EUR" : settings.defaultCurrency }
    public var contributionInvalid: Bool { contributionAmount.map { $0.isNaN || $0 < 0 } ?? true }
    public var targetInvalid: Bool {
        !targetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (targetAmount.map { $0.isNaN || $0 <= 0 } ?? true)
    }
    public var inputsValid: Bool { !contributionInvalid && !targetInvalid }
    public var visibleForecast: ResearchForecastData? { visibleSnapshot?.data }
    public var visibleSnapshot: ResearchSnapshot<ResearchForecastData>? {
        guard inputsValid, !isDebouncing, resultInput == currentInput else { return nil }
        return result
    }
    /// Immediate camel-case inputs, also supplied to the independent Life panel.
    /// Invalid main money fields are null placeholders; Life preparation replaces them.
    public var currentInput: TaxValue {
        var fields: [String: TaxValue] = [
            "horizonMonths": .number(Decimal(horizonMonths)),
            "monthlyContribution": contributionAmount.map(TaxValue.number) ?? .null,
            "forwardBlend": .number(returnSource == "blended" ? Decimal(blendPct) / 100 : 0),
            "method": .string(method), "paths": .number(Decimal(paths)), "currency": .string(currency),
        ]
        if !targetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fields["targetValue"] = targetAmount.map(TaxValue.number) ?? .null
        }
        return .object(fields)
    }
    public var isOnline = true { didSet { if !isOnline { cancelReads() } } }
    @ObservationIgnored public var didChangeInput: (@MainActor () -> Void)?
    @ObservationIgnored private let service: any ForecastService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private let debounceNanoseconds: UInt64
    @ObservationIgnored private var active = false
    @ObservationIgnored private var suppressed = false
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var readingInput: TaxValue?
    private var resultInput: TaxValue?
    private var result: ResearchSnapshot<ResearchForecastData>?
    @ObservationIgnored private var previousInput: TaxValue?
    private var contributionAmount: Decimal? {
        contributionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? 0 : LocaleNumber.parse(contributionText, format: settings.numberFormat)
    }
    private var targetAmount: Decimal? { LocaleNumber.parse(targetText, format: settings.numberFormat) }
    public init(service: any ForecastService, cache: ResearchReadCache? = nil, debounceMilliseconds: Int = 450) {
        self.service = service
        self.cache = cache ?? ResearchReadCache()
        debounceNanoseconds = UInt64(max(0, debounceMilliseconds)) * 1_000_000
        previousInput = currentInput
    }
    public func configure(settings: NativeAppSettings) {
        let oldInput = currentInput
        self.settings = settings
        if oldInput != currentInput { inputsChanged() } else { didChangeInput?() }
    }
    public func load(force: Bool = false) async {
        active = true
        if isDebouncing, !force {
            await debounceTask?.value
            return
        }
        if force {
            debounceTask?.cancel()
            debounceTask = nil
            isDebouncing = false
        }
        await performRead(force: force)
    }
    public func beginVisit() { active = true }
    private func inputsChanged() {
        guard !suppressed else { return }
        didChangeInput?()
        let input = currentInput
        guard input != previousInput || !inputsValid else { return }
        previousInput = input
        cancelReads()
        error = nil
        guard active, inputsValid else { return }
        isDebouncing = true
        let token = generation
        debounceTask = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds: debounceNanoseconds) } catch { return }
            guard active, token == generation, input == currentInput else { return }
            isDebouncing = false
            await performRead(force: false)
            if token == generation { debounceTask = nil }
        }
    }
    private func performRead(force: Bool) async {
        guard active, inputsValid else { return }
        let input = currentInput
        if !force, readingInput == input, let readTask {
            await readTask.value
            return
        }
        let key = Self.cacheKey(input)
        if !isOnline {
            if let cached = cache.cached(key: key, as: ResearchSnapshot<ResearchForecastData>.self) {
                result = cached
                resultInput = input
            }
            return
        }
        let token = UUID()
        generation = token
        readTask?.cancel()
        if force { cache.invalidate(key: key) }
        readingInput = input
        isFetching = true
        error = nil
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let output: ResearchSnapshot<ResearchForecastData> = try await cache.request(
                    key: key, freshFor: 300, force: force
                ) { [service] in
                    try await service.researchPortfolioForecast(input)
                }
                guard active, token == generation, input == currentInput, !Task.isCancelled else { return }
                result = output
                resultInput = input
            } catch {
                guard active, token == generation, input == currentInput, !Task.isCancelled else { return }
                if !(error is CancellationError) { self.error = error.localizedDescription }
            }
            if token == generation {
                isFetching = false
                readingInput = nil
            }
        }
        readTask = task
        await task.value
        if token == generation { readTask = nil }
    }
    public func invalidate() {
        cancelReads()
        cache.invalidate(prefix: "portfolio-forecast:")
        result = nil
        resultInput = nil
    }
    public func didDisappear() {
        active = false
        cancelReads()
        suppressed = true
        horizonMonths = 60
        contributionText = ""
        targetText = ""
        returnSource = "historical"
        blendPct = 50
        method = "parametric"
        paths = 1000
        suppressed = false
        result = nil
        resultInput = nil
        previousInput = currentInput
        error = nil
        didChangeInput?()
    }
    private func cancelReads() {
        generation = UUID()
        debounceTask?.cancel()
        debounceTask = nil
        readTask?.cancel()
        readTask = nil
        readingInput = nil
        isFetching = false
        isDebouncing = false
    }
    private static func cacheKey(_ input: TaxValue) -> String {
        "portfolio-forecast:" + String(decoding: (try? APIBody.encode(input)) ?? Data(), as: UTF8.self)
    }
}
