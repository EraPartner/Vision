#if canImport(AppKit)
    import AppKit
    import PDFKit
    import SwiftUI
    import Testing
    import VisionNativeCore
    @testable import VisionNativeUI

    @MainActor @Suite("Frozen Statistics table rows across printed pages")
    struct NativeStatisticsRowPrintRenderTests {
        init() throws {
            try NativeAppKitTestApplication.prepare()
        }

        private let strings = CatalogStrings(language: .en)
        private let settings = NativeAppSettings(showDecimalPlaces: 12)

        private func loaded(_ tab: String) async throws
            -> (StatisticsScreens, StatisticsRowsPrintTransport, NativeRoute)
        {
            let transport = StatisticsRowsPrintTransport()
            let client = APIClient(
                baseURL: { URL(string: "http://127.0.0.1:54332") }, transport: transport, maxRetries: 0)
            let model = StatisticsModel(service: client, now: { Date(timeIntervalSince1970: 1_791_936_000) })
            let screens = StatisticsScreens(
                model: model, saved: SavedChartsModel(service: client), digest: StatisticsDigestModel(service: client))
            let route = NativeRoute("/statistics?window=all&tab=" + tab)!
            await model.appear(settings: settings, route: route)
            try #require(model.hasData, "\(model.error ?? "Missing frozen synthetic Statistics data")")
            return (screens, transport, route)
        }
        private func capture(_ screens: StatisticsScreens, route: NativeRoute) throws
            -> NativeStatisticsPrintPresentation
        {
            NativeStatisticsPrintPresentation.prepare(
                try NativeStatisticsPrintSnapshot(
                    screens: screens, settings: settings, strings: strings, theme: .init(appearance: .dark),
                    route: route))
        }

        @Test(arguments: [CGFloat(451), CGFloat(540)])
        func pivotKeepsExpandedRowsWholeRepeatsHeadersAndPrintsExactAmounts(_ width: CGFloat) async throws {
            let (screens, transport, route) = try await loaded("categories")
            screens.model.pivotYear = 2026
            screens.model.categoryMetric = .expense
            screens.model.collapsedGroups = []
            let presentation = try capture(screens, route: route)
            let before = await transport.requests
            screens.model.collapsedGroups = ["id:1"]
            screens.model.pivotYear = 2008
            let pages = NativePagePrintPagesView(printInfo: paper(width: width, height: 340)) { width in
                NativeStatisticsPrintDocument.printBlocks(
                    presentation: presentation, width: width, sections: [.pivotTable(0)])
            }
            let rowPages = try expectWholeRows(pages, prefix: "statistics.pivotTable:0", expected: 10)
            #expect(Set(rowPages.values).count > 1)
            let documents = try render(pages)
            for page in Set(rowPages.values) {
                #expect(compact(documents[page - 1].string ?? "").contains(compact(month(1))))
                #expect(documents[page - 1].string?.contains(strings.t("categories.title")) == true)
            }
            for index in 1...9 {
                try expectSamePage(documents, first: "PivotBegin\(index)", last: "PivotEnd\(index)")
            }
            try expectSamePage(documents, first: "ChildBegin", last: "ChildEnd")
            let footers = descendants(pages).filter { $0.identifier?.rawValue == "statistics.pivotTable:0.footer" }
            #expect(footers.count == 1)
            #expect(presentation.snapshot.pivotYear == 2026 && presentation.snapshot.collapsedGroups.isEmpty)
            let first = try #require(documents.first)
            let page = try #require(first.page(at: 0))
            let january = try #require(first.findString(month(1), withOptions: []).last).bounds(for: page)
            let february = try #require(first.findString(month(2), withOptions: []).last).bounds(for: page)
            let columnWidth = february.maxX - january.maxX - 8
            let column = NSRect(
                x: january.maxX - columnWidth - 1, y: 0, width: columnWidth + 2,
                height: page.bounds(for: .mediaBox).height)
            let columnText = documents.compactMap { $0.page(at: 0)?.selection(for: column)?.string }.joined()
            let expected = MoneyText.text(
                Decimal(string: StatisticsRowsPrintTransport.amount)!, currency: "EUR", settings: settings,
                signed: false)
            #expect(compact(columnText).contains(compact(expected)))
            expectHorizontalBounds(documents)
            #expect(await transport.requests == before)
        }

        /// The pivot's column label for a 2026 month, as the screen prints it.
        private func month(_ index: Int) -> String {
            StatisticsPeriodFormat.short(String(format: "2026-%02d", index), locale: LanguageLocale.locale(.en))
        }

        @Test func allPivotColumnWindowsAndChangedMarginsReuseOnlyFrozenValues() async throws {
            let (screens, transport, route) = try await loaded("categories")
            screens.model.collapsedGroups = ["id:1"]
            let presentation = try capture(screens, route: route)
            let before = await transport.requests
            let info = paper(width: 451, height: 800)
            let pages = NativePagePrintPagesView(printInfo: info) { width in
                NativeStatisticsPrintDocument.printBlocks(presentation: presentation, width: width)
            }
            var rendered = try render(pages)
            var text = rendered.compactMap(\.string).joined(separator: "\n")
            for index in 1...12 { #expect(compact(text).contains(compact(month(index)))) }
            for window in 0..<3 {
                _ = try expectWholeRows(pages, prefix: "statistics.pivotTable:\(window)", expected: 9)
            }
            info.leftMargin += 35
            _ = pageRange(pages)
            #expect(pages.rectForPage(1).width == 416)
            rendered = try render(pages)
            text = rendered.compactMap(\.string).joined(separator: "\n")
            for index in 1...12 { #expect(compact(text).contains(compact(month(index)))) }
            expectHorizontalBounds(rendered)
            #expect(await transport.requests == before)
        }

        @Test func recipientsKeepLoadedLimitSortAndColumnAlignmentAcrossContinuations() async throws {
            let (screens, transport, route) = try await loaded("recipients")
            screens.model.recipientVisibleCount = 8
            screens.model.recipientQuery.toggleSort("transactionCount")
            let presentation = try capture(screens, route: route)
            let before = await transport.requests
            screens.model.recipientVisibleCount = 1
            screens.model.recipientQuery.search = "Nothing matches this changed live query"
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 350)) { width in
                let blocks = NativeStatisticsPrintDocument.printBlocks(
                    presentation: presentation, width: width, sections: [.recipients])
                #expect(blocks.count == 3)
                // The separate ranked chart legitimately includes payees beyond the
                // details table's loaded limit. Inspect the exported table itself.
                return blocks.filter { $0 is NativePagePrintTableBlock }
            }
            let rowPages = try expectWholeRows(pages, prefix: "statistics.recipients", expected: 8)
            #expect(Set(rowPages.values).count > 1)
            let documents = try render(pages)
            for index in 1...8 { try expectSamePage(documents, first: "PayeeBegin\(index)", last: "PayeeEnd\(index)") }
            let text = compact(documents.compactMap(\.string).joined())
            #expect(!text.contains("PayeeBegin9"))
            let xs = try (1...8).map { index -> CGFloat in
                let bounds = documents.compactMap { $0.page(at: 0) }
                    .compactMap { NativePDFGlyphs.bounds(of: String(771_000 + index), in: $0) }.first
                let layout = documents.compactMap { $0.page(at: 0).map(NativePDFGlyphs.layout) }
                    .joined(separator: "\n---\n")
                return try #require(bounds, "Count \(771_000 + index) missing from:\n\(layout)").maxX
            }
            #expect((xs.max() ?? 0) - (xs.min() ?? 0) < 1)
            for page in Set(rowPages.values) {
                #expect(
                    compact(documents[page - 1].string ?? "").contains(compact(strings.t("insights.transactionCount"))))
            }
            expectHorizontalBounds(documents)
            #expect(await transport.requests == before)
        }

        @Test func yearlySummaryUsesStableColumnsAndWholeRowsForEveryLoadedYear() async throws {
            let (screens, transport, route) = try await loaded("yearly")
            let presentation = try capture(screens, route: route)
            let before = await transport.requests
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 290)) { width in
                NativeStatisticsPrintDocument.printBlocks(
                    presentation: presentation, width: width, sections: [.yearlySummary])
            }
            let rowPages = try expectWholeRows(pages, prefix: "statistics.yearlySummary", expected: 19)
            #expect(Set(rowPages.values).count > 1)
            let documents = try render(pages)
            let text = documents.compactMap(\.string).joined(separator: "\n")
            for year in 2008...2026 { #expect(text.contains(String(year))) }
            for page in Set(rowPages.values) {
                #expect(
                    compact(documents[page - 1].string ?? "").contains(
                        compact(strings.t("statsPage.yearly.transactions"))))
            }
            expectHorizontalBounds(documents)
            #expect(await transport.requests == before)
        }

        private func compact(_ text: String) -> String { text.filter { !$0.isWhitespace } }
        private func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        private func expectWholeRows(_ pages: NativePagePrintPagesView, prefix: String, expected: Int) throws
            -> [String: Int]
        {
            let all = descendants(pages)
            let rows = all.filter { $0.identifier?.rawValue.hasPrefix(prefix + ".row.") == true }
            #expect(rows.count == expected)
            var result: [String: Int] = [:]
            for row in rows {
                let id = try #require(row.identifier?.rawValue)
                let bounds = row.convert(row.bounds, to: pages)
                let containing = (1...pageRange(pages).length).filter {
                    pages.rectForPage($0).insetBy(dx: -0.5, dy: -0.5).contains(bounds)
                }
                #expect(containing.count == 1, "Logical row split across paper: \(id), \(bounds)")
                result[id] = try #require(containing.first)
            }
            let headers = all.filter { $0.identifier?.rawValue == prefix + ".header" }
            for page in Set(result.values) {
                #expect(
                    headers.contains {
                        pages.rectForPage(page).insetBy(dx: -0.5, dy: -0.5).contains($0.convert($0.bounds, to: pages))
                    })
            }
            return result
        }
        private func expectSamePage(_ documents: [PDFDocument], first: String, last: String) throws {
            let firstPages = documents.indices.filter { !documents[$0].findString(first, withOptions: []).isEmpty }
            let lastPages = documents.indices.filter { !documents[$0].findString(last, withOptions: []).isEmpty }
            #expect(
                firstPages.count == 1 && firstPages == lastPages, "Wrapped label split or missing: \(first), \(last)")
        }
        private func paper(width: CGFloat, height: CGFloat) -> NSPrintInfo {
            let info = NSPrintInfo(dictionary: [:])
            info.paperSize = NSSize(width: width + 72, height: height + 72)
            info.leftMargin = 36
            info.rightMargin = 36
            info.topMargin = 36
            info.bottomMargin = 36
            return info
        }
        private func pageRange(_ pages: NativePagePrintPagesView) -> NSRange {
            var range = NSRange()
            #expect(pages.knowsPageRange(&range))
            return range
        }
        private func render(_ pages: NativePagePrintPagesView) throws -> [PDFDocument] {
            try NativePrintPDFRenderer.render(pages)
        }
        private func expectHorizontalBounds(_ documents: [PDFDocument]) {
            for document in documents {
                guard let page = document.page(at: 0) else { continue }
                let paper = page.bounds(for: .mediaBox)
                for index in 0..<page.numberOfCharacters {
                    let box = page.characterBounds(at: index)
                    if box.width > 0, box.height > 0 {
                        #expect(box.minX >= paper.minX - 1 && box.maxX <= paper.maxX + 1)
                    }
                }
            }
        }
    }

    @MainActor private final class StatisticsRowsPrintCanvas: NSView { override var isFlipped: Bool { true } }

    private actor StatisticsRowsPrintTransport: APITransport {
        static let amount = "123456789012345.123456789012"
        private(set) var requests = 0
        func send(_ request: APIRequest) async throws -> APIResponse {
            requests += 1
            let body: String
            switch request.url.path {
            case "/api/settings/dashboard_settings":
                body =
                    #"{"key":"dashboard_settings","value":{"excludeHiddenCategories":false},"expected":{"exists":true,"value":{"excludeHiddenCategories":false}}}"#
            case "/api/settings/widget_visibility":
                body =
                    #"{"key":"widget_visibility","value":{"statistics":{"categoryPie":false,"categoryTrend":false,"yearlyComparison":false}},"expected":{"exists":true,"value":{}}}"#
            case "/api/aggregations/monthly-summary":
                let months =
                    (2008...2026).map { year in
                        "{\"month\":1,\"year\":\(year),\"period_start\":\"\(year)-01-01\",\"period_end\":\"\(year)-01-31\",\"total_income\":\(Self.amount),\"total_spending\":-250,\"net_amount\":750,\"transaction_count\":771001}"
                    }
                    + (2...12).map { month in
                        "{\"month\":\(month),\"year\":2026,\"period_start\":\"2026-\(String(format: "%02d", month))-01\",\"period_end\":\"2026-\(String(format: "%02d", month))-28\",\"total_income\":1000,\"total_spending\":-250,\"net_amount\":750,\"transaction_count\":2}"
                    }
                body = "{\"months\":[" + months.joined(separator: ",") + "]}"
            case "/api/aggregations/category-pivot":
                let periods = (1...12).map { month in
                    let rows =
                        (1...9).map { index in
                            let name = "PivotBegin\(index) category with a complete wrapped label PivotEnd\(index)"
                            return
                                "{\"categoryId\":\(index),\"categoryName\":\"\(name)\",\"categoryPathIds\":[\(index)],\"categoryPathSegments\":[\"\(name)\"],\"total\":-\(Self.amount),\"expense\":-\(Self.amount),\"income\":0,\"transactionCount\":1}"
                        } + [
                            #"{"categoryId":1001,"categoryName":"ChildBegin child with a complete wrapped label ChildEnd","categoryPathIds":[1,1001],"categoryPathSegments":["PivotBegin1 category with a complete wrapped label PivotEnd1","ChildBegin child with a complete wrapped label ChildEnd"],"total":-1,"expense":-1,"income":0,"transactionCount":1}"#
                        ]
                    return "\"2026-\(String(format: "%02d", month))\":[" + rows.joined(separator: ",") + "]"
                }
                body = "{\"categoryPivot\":{" + periods.joined(separator: ",") + "}}"
            case "/api/aggregations/recipient-insights":
                let rows = (1...9).map { index in
                    // The widest amounts appear only on the last loaded row, so
                    // sizing each continuation independently moves the count column.
                    let amount = index == 8 ? Self.amount : "12.34"
                    return
                        "{\"recipientId\":\(index),\"name\":\"PayeeBegin\(index) complete wrapped recipient label PayeeEnd\(index)\",\"totalSpend\":\(amount),\"avgAmount\":\(amount),\"transactionCount\":\(771000 + index),\"firstSeen\":\"2020-01-01\",\"lastSeen\":\"2026-09-01\"}"
                }
                body = "{\"topMerchants\":[" + rows.joined(separator: ",") + "],\"monthOverMonth\":[]}"
            case "/api/aggregations/recipient-by-year": body = #"{"recipientsByYear":{}}"#
            default: throw APIError.invalidRequest("Unexpected frozen row-print request: " + request.url.path)
            }
            return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(body)}".utf8))
        }
    }
#endif
