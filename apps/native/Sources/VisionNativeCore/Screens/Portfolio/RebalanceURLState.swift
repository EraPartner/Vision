import Foundation

public struct RebalanceDraftRow: Equatable, Sendable {
    public var sleeve: String
    public var pct: String
    public init(sleeve: String, pct: String) {
        self.sleeve = sleeve
        self.pct = pct
    }
}
public struct RebalanceURLDraft: Equatable, Sendable {
    public var source: String
    public var rows: [RebalanceDraftRow]
    public var name: String
    public var capEnabled: Bool
    public var cap: String
    public static let sleeves = [
        "stocks", "intl_stocks", "bonds", "gold", "commodities", "crypto", "real_estate", "savings",
    ]
    public static var defaults: Self {
        Self(
            source: "model:sixty_forty", rows: [.init(sleeve: "stocks", pct: "60"), .init(sleeve: "bonds", pct: "40")],
            name: "", capEnabled: false, cap: "")
    }
    public init(source: String, rows: [RebalanceDraftRow], name: String, capEnabled: Bool, cap: String) {
        self.source = source
        self.rows = rows
        self.name = name
        self.capEnabled = capEnabled
        self.cap = cap
    }
    public var preset: RebalancePreset? {
        source.hasPrefix("model:") ? RebalancePreset(rawValue: String(source.dropFirst(6))) : nil
    }
    public var planId: String? { source.hasPrefix("plan:") ? String(source.dropFirst(5)) : nil }
}

public enum RebalanceURLState {
    public static func parse(_ route: NativeRoute) -> RebalanceURLDraft {
        let source = validSource(route.value("source"))
        let rows = route.query.filter { $0.name == "target" }.prefix(8).compactMap { item -> RebalanceDraftRow? in
            let text = item.value ?? ""
            guard let separator = text.firstIndex(of: ":") else { return nil }
            let sleeve = String(text[..<separator])
            guard sleeve.isEmpty || RebalanceURLDraft.sleeves.contains(sleeve) else { return nil }
            return RebalanceDraftRow(sleeve: sleeve, pct: limit(String(text[text.index(after: separator)...]), 32))
        }
        return RebalanceURLDraft(
            source: source, rows: rows.isEmpty ? RebalanceURLDraft.defaults.rows : rows,
            name: limit(route.value("name") ?? "", 80), capEnabled: route.query.contains { $0.name == "cap" },
            cap: limit(route.value("cap") ?? "", 32))
    }
    public static func write(_ draft: RebalanceURLDraft, preserving route: NativeRoute) -> NativeRoute {
        var items = route.query.filter { !["source", "target", "name", "cap"].contains($0.name) }
        if draft.source != "model:sixty_forty" { items.append(.init(name: "source", value: validSource(draft.source))) }
        if !draft.source.hasPrefix("model:") {
            items += draft.rows.prefix(8).map { .init(name: "target", value: "\($0.sleeve):\(limit($0.pct, 32))") }
            if !draft.name.isEmpty { items.append(.init(name: "name", value: limit(draft.name, 80))) }
            if draft.capEnabled { items.append(.init(name: "cap", value: limit(draft.cap, 32))) }
        }
        return NativeRoute(path: route.path, query: items)
    }
    private static func validSource(_ input: String?) -> String {
        guard let input else { return "model:sixty_forty" }
        if input == "custom" || RebalancePreset.allCases.contains(where: { "model:\($0.rawValue)" == input })
            || (input.hasPrefix("plan:") && input.utf16.count > 5 && input.utf16.count <= 133)
        {
            return input
        }
        return "model:sixty_forty"
    }
    /// JavaScript slice limits code units; URLSearchParams replaces an isolated surrogate.
    private static func limit(_ value: String, _ count: Int) -> String {
        String(decoding: value.utf16.prefix(count), as: UTF16.self)
    }
}
