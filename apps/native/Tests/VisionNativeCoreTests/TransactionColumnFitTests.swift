import Testing
@testable import VisionNativeCore

@Suite struct TransactionColumnFitTests {
    private let columns: [TransactionColumn] = [.date, .recipient, .category, .bank, .amount]
    /// Select box 32 + Edit 64 + horizontal padding 32.
    private let chrome = 128.0

    @Test func wideTableKeepsDefaultWidths() {
        let widths = TransactionColumn.fittedWidths(columns, resized: [:], available: 1400, chrome: chrome)
        #expect(widths["date"] == 128)
        #expect(widths["recipient"] == 280)
        #expect(widths["bank"] == 220)
        #expect(widths["amount"] == 120)
        #expect(widths["category"] == 240)
    }

    /// Regression: at a 1,000 pt table the default widths (1,116 pt with chrome) pushed the
    /// Amount and Edit columns and the page's header actions past the window edge.
    @Test func narrowTableShrinksFixedColumnsToFit() throws {
        let widths = TransactionColumn.fittedWidths(columns, resized: [:], available: 1000, chrome: chrome)
        let total = chrome + columns.reduce(0) { $0 + (widths[$1.rawValue] ?? 0) }
        #expect(abs(total - 1000) < 0.001)
        for column in columns {
            let width = try #require(widths[column.rawValue])
            #expect(width >= column.minWidth && width <= column.width)
        }
    }

    @Test func shortfallBeyondTheMinimumsStopsAtTheMinimums() {
        let widths = TransactionColumn.fittedWidths(columns, resized: [:], available: 600, chrome: chrome)
        #expect(widths["date"] == 104)
        #expect(widths["recipient"] == 180)
        #expect(widths["bank"] == 160)
        #expect(widths["amount"] == 90)
    }

    @Test func resizedColumnsKeepTheirWidth() {
        let widths = TransactionColumn.fittedWidths(
            columns, resized: ["recipient": 300, "category": 260], available: 1000, chrome: chrome)
        #expect(widths["recipient"] == 300)
        #expect(widths["category"] == 260)
        #expect((widths["date"] ?? 0) < 128)
    }
}
