import Foundation

public enum CustomChartKind: String, CaseIterable, Sendable {
    case line, bar, stackedBar, groupedBar, rankedBar, area, stackedArea
    public var chartType: String { self == .line ? "line" : self == .area || self == .stackedArea ? "area" : "bar" }
    public var variant: String {
        self == .stackedBar || self == .stackedArea
            ? "stacked" : self == .rankedBar ? "ranked" : self == .groupedBar ? "grouped" : "default"
    }
    public var labelKey: String {
        switch self {
        case .line: return "customChart.line"
        case .bar: return "customChart.bar"
        case .stackedBar: return "customChart.barStacked"
        case .groupedBar: return "customChart.barGrouped"
        case .rankedBar: return "customChart.barRanked"
        case .area: return "customChart.area"
        case .stackedArea: return "customChart.areaStacked"
        }
    }
}

public struct CustomChartDraft: Equatable, Sendable, Encodable {
    public var name = ""
    public var kind: CustomChartKind = .line
    public var timeBucket = "monthly"
    public var categoryIds: [Int] = []
    public var recipientIds: [Int] = []
    public var tagIds: [Int] = []
    public var allCategories = false
    public var allRecipients = false
    public var allTags = false
    public var dateRangeStart: String?
    public var dateRangeEnd: String?
    public init() {}
    public init(chart: OpenAPI.SavedChart) {
        name = chart.name
        timeBucket = chart.timeBucket
        kind =
            CustomChartKind.allCases.first { $0.chartType == chart.chartType && $0.variant == chart.chartVariant }
            ?? .line
        categoryIds = chart.categoryIds
        recipientIds = chart.recipientIds
        tagIds = chart.tagIds
        allCategories = chart.allCategories
        allRecipients = chart.allRecipients
        allTags = chart.allTags
        dateRangeStart = chart.dateRangeStart
        dateRangeEnd = chart.dateRangeEnd
    }
    public var canSave: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 500
            && (allCategories || allRecipients || allTags
                || !categoryIds.isEmpty || !recipientIds.isEmpty || !tagIds.isEmpty)
    }
    public var capsLongTail: Bool { allCategories || allRecipients || allTags }
    public func includesPeriod(_ period: String) -> Bool {
        let length = period.count == 4 ? 4 : 7
        return (dateRangeStart.map { period >= String($0.prefix(length)) } ?? true)
            && (dateRangeEnd.map { period <= String($0.prefix(length)) } ?? true)
    }
    enum CodingKeys: String, CodingKey {
        case name, chartType, chartVariant, timeBucket, categoryIds, recipientIds, tagIds
        case allCategories, allRecipients, allTags, dateRangeStart, dateRangeEnd
    }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .name)
        try container.encode(kind.chartType, forKey: .chartType)
        try container.encode(kind.variant, forKey: .chartVariant)
        try container.encode(timeBucket, forKey: .timeBucket)
        try container.encode(categoryIds, forKey: .categoryIds)
        try container.encode(recipientIds, forKey: .recipientIds)
        try container.encode(tagIds, forKey: .tagIds)
        try container.encode(allCategories, forKey: .allCategories)
        try container.encode(allRecipients, forKey: .allRecipients)
        try container.encode(allTags, forKey: .allTags)
        if let dateRangeStart {
            try container.encode(dateRangeStart, forKey: .dateRangeStart)
        } else {
            try container.encodeNil(forKey: .dateRangeStart)
        }
        if let dateRangeEnd {
            try container.encode(dateRangeEnd, forKey: .dateRangeEnd)
        } else {
            try container.encodeNil(forKey: .dateRangeEnd)
        }
    }
}

public struct CustomRecipientPivot: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public let recipientId: Int
        public let name: String
        public let total: Decimal
    }
    public struct Conversion: Decodable, Equatable, Sendable {
        public let usedHistoricalFallback: Bool
        public let unconvertedCurrencies: [String]?
    }
    public let recipientPivot: [String: [Item]]
    public let conversion: Conversion?
}

public struct CustomTagPivot: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public let tagId: Int
        public let slug: String
        public let total: Decimal
    }
    public let tagPivot: [String: [Item]]
}

public struct CustomChartEntity: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let values: [String: Decimal]
    public var total: Decimal { values.values.reduce(0, +) }
    public init(id: String, name: String, values: [String: Decimal]) {
        self.id = id
        self.name = name
        self.values = values
    }
}

public struct CustomChartDataset: Equatable, Sendable {
    public let periods: [String]
    public let entities: [CustomChartEntity]
    public let usesHistoricalFallback: Bool
    public init(
        configuration: CustomChartDraft, statistics: StatisticsSnapshot,
        recipients: CustomRecipientPivot?, tags: CustomTagPivot?, otherLabel: String
    ) {
        var entities: [CustomChartEntity] = []
        let categories = statistics.categories(metric: .absolute)
        for row in categories
        where row.id != "null"
            && (configuration.allCategories || row.categoryIds.contains { configuration.categoryIds.contains($0) })
        {
            var values: [String: Decimal] = [:]
            for (period, amount) in row.values {
                let key = configuration.timeBucket == "yearly" ? String(period.prefix(4)) : period
                if configuration.includesPeriod(key) { values[key, default: 0] += amount }
            }
            entities.append(CustomChartEntity(id: "cat:\(row.id)", name: row.name, values: values))
        }
        var recipientRows: [Int: CustomChartEntity] = [:]
        for (period, items) in recipients?.recipientPivot ?? [:] where configuration.includesPeriod(period) {
            for item in items where configuration.allRecipients || configuration.recipientIds.contains(item.recipientId)
            {
                var values = recipientRows[item.recipientId]?.values ?? [:]
                values[period, default: 0] += abs(item.total)
                recipientRows[item.recipientId] = CustomChartEntity(
                    id: "rec:\(item.recipientId)", name: item.name, values: values)
            }
        }
        entities += recipientRows.values.sorted { $0.id < $1.id }
        var tagRows: [Int: CustomChartEntity] = [:]
        for (period, items) in tags?.tagPivot ?? [:] where configuration.includesPeriod(period) {
            for item in items where configuration.allTags || configuration.tagIds.contains(item.tagId) {
                var values = tagRows[item.tagId]?.values ?? [:]
                values[period, default: 0] += abs(item.total)
                tagRows[item.tagId] = CustomChartEntity(id: "tag:\(item.tagId)", name: "#" + item.slug, values: values)
            }
        }
        entities += tagRows.values.sorted { $0.id < $1.id }
        periods = Array(Set(entities.flatMap { $0.values.keys })).sorted()
        if configuration.kind == .rankedBar || configuration.capsLongTail {
            entities.sort { $0.total == $1.total ? $0.id < $1.id : $0.total > $1.total }
        }
        if configuration.capsLongTail && entities.count > 8 {
            var values: [String: Decimal] = [:]
            for entity in entities.dropFirst(8) {
                for (period, amount) in entity.values { values[period, default: 0] += amount }
            }
            entities = Array(entities.prefix(8)) + [CustomChartEntity(id: "other", name: otherLabel, values: values)]
        }
        self.entities = entities
        usesHistoricalFallback = recipients?.conversion?.usedHistoricalFallback ?? false
    }
    public var series: [InsightChartSeries] {
        entities.map { entity in
            InsightChartSeries(
                id: entity.id, label: entity.name,
                points: periods.map { InsightChartPoint(key: $0, value: entity.values[$0] ?? 0) })
        }
    }
}
