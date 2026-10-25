#if canImport(AppKit)
    import AppKit
    import PDFKit
    import SwiftUI
    import Testing
    import VisionNativeCore
    @testable import VisionNativeUI

    /// Measures the production paginator and renders its actual page rectangles to PDF.
    /// This exercises AppKit/SwiftUI layout, not a printer driver or the system print panel.
    @MainActor @Suite("Current-page print layout and PDF rendering")
    struct NativePagePrintRenderTests {
        init() throws {
            try NativeAppKitTestApplication.prepare()
        }

        @Test func swiftUITextDrawsAsVectorTextOnEveryPageWithoutChangingTheKeyWindow() throws {
            let keyWindow = NSApplication.shared.keyWindow
            let pages = NativePagePrintPagesView(printInfo: paper(width: 240, height: 120)) { width in
                ["First SwiftUI page", "Second SwiftUI page"].map { marker in
                    NativePrintHostingView(
                        rootView: Text(marker).font(.system(size: 14)).foregroundStyle(.black)
                            .frame(width: width, height: 100, alignment: .topLeading))
                }
            }
            #expect(pageRange(pages).length == 2)
            let documents = try render(pages)
            for (index, marker) in ["First SwiftUI page", "Second SwiftUI page"].enumerated() {
                let page = try #require(documents[index].page(at: 0))
                let selection = try #require(documents[index].findString(marker, withOptions: []).first)
                #expect(page.bounds(for: .mediaBox).contains(selection.bounds(for: page)))
                #expect(documents[1 - index].findString(marker, withOptions: []).isEmpty)
            }
            #expect(NSApplication.shared.keyWindow === keyWindow)
        }

        @Test func shortSectionsMoveTogetherAndExactPageDoesNotAddABlankTail() throws {
            let info = paper(width: 480, height: 300)
            let first = MeasuredPrintBlock(height: 180, labels: [(20, "First section")])
            let second = MeasuredPrintBlock(height: 160, labels: [(20, "Second section")])
            let pages = NativePagePrintPagesView(printInfo: info) { width in
                #expect(width == 480)
                return [first, second]
            }
            #expect(first.frame == NSRect(x: 0, y: 0, width: 480, height: 180))
            #expect(second.frame == NSRect(x: 0, y: 300, width: 480, height: 160))
            #expect(pageRange(pages) == NSRange(location: 1, length: 2))
            let rendered = try render(pages)
            #expect(rendered[0].string?.contains("First section") == true)
            #expect(rendered[1].string?.contains("Second section") == true)
            let exact = NativePagePrintPagesView(printInfo: info) { _ in [MeasuredPrintBlock(height: 300)] }
            #expect(pageRange(exact).length == 1)
            let empty = NativePagePrintPagesView(printInfo: info) { _ in [] }
            #expect(pageRange(empty).length == 1)
        }

        @Test func oversizedSectionsContinueThroughEveryPageRectangleInOrder() throws {
            let block = MeasuredPrintBlock(
                height: 760,
                labels: [(20, "Top continuation"), (320, "Middle continuation"), (620, "Last continuation")])
            let pages = NativePagePrintPagesView(printInfo: paper(width: 480, height: 300)) { _ in [block] }
            #expect(pageRange(pages).length == 3)
            #expect(pages.rectForPage(3) == NSRect(x: 0, y: 600, width: 480, height: 300))
            let rendered = try render(pages)
            for (index, word) in ["Top", "Middle", "Last"].enumerated() {
                #expect(rendered[index].string?.contains(word + " continuation") == true)
                let page = try #require(rendered[index].page(at: 0))
                let marker = try #require(rendered[index].findString(word + " continuation", withOptions: []).first)
                #expect(page.bounds(for: .mediaBox).contains(marker.bounds(for: page)))
            }
        }

        @Test func changedPaperAndMarginsRemeasureFrozenSectionsOnlyWhenDimensionsChange() {
            let info = paper(width: 480, height: 700)
            var measuredWidths: [CGFloat] = []
            let pages = NativePagePrintPagesView(printInfo: info) { width in
                measuredWidths.append(width)
                return [MeasuredPrintBlock(height: 500), MeasuredPrintBlock(height: 100)]
            }
            #expect(pageRange(pages).length == 1)
            #expect(pageRange(pages).length == 1)
            #expect(measuredWidths == [480])
            info.leftMargin += 80
            #expect(pageRange(pages).length == 1)
            #expect(measuredWidths == [480, 400])
            #expect(pages.rectForPage(1).width == 400)
            info.leftMargin += 10
            info.rightMargin -= 10
            #expect(pageRange(pages).length == 1)
            #expect(measuredWidths == [480, 400])
            info.topMargin += 250
            #expect(pageRange(pages).length == 2)
            #expect(pages.rectForPage(2).minY == 450)
            #expect(pages.rectForPage(2).height == 450)
            info.paperSize = NSSize(width: 772, height: 1172)
            #expect(pageRange(pages).length == 1)
            #expect(pages.rectForPage(1).width == 620)
            #expect(pages.rectForPage(1).height == 850)
            #expect(measuredWidths == [480, 400, 400, 620])
            #expect(pages.subviews.count == 2)
        }

        @Test func landscapePaginationUsesTheChangedOrientationRatherThanInitialPortraitSize() {
            let info = paper(width: 480, height: 700)
            info.orientation = .portrait
            var widths: [CGFloat] = []
            let pages = NativePagePrintPagesView(printInfo: info) { width in
                widths.append(width)
                return [MeasuredPrintBlock(height: 300), MeasuredPrintBlock(height: 200)]
            }
            #expect(pageRange(pages).length == 1)
            info.orientation = .landscape
            #expect(pageRange(pages).length == 2)
            #expect(widths == [480, 700])
            #expect(pages.rectForPage(2) == NSRect(x: 0, y: 480, width: 700, height: 480))
        }

        @Test(arguments: [CGFloat(451), CGFloat(540)])
        func taxComparisonAndExpandedHouseholdFitPrintableWidth(_ width: CGFloat) async throws {
            let strings = CatalogStrings(language: .en)
            let snapshot = try NativeTaxPrintSnapshot(
                overview: decode(OpenAPI.BelgianTaxOverview.self, NativePrintRenderFixtures.taxOverview),
                dashboard: decode(TaxDashboardData.self, NativePrintRenderFixtures.taxDashboard),
                settings: .defaults, strings: strings, theme: .init(appearance: .dark),
                visibleWidgets: ["yearComparison", "householdBreakdown"],
                localState: .init(comparisonYear: 2024, householdExpanded: true))
            let presentation = try await NativeTaxPrintPresentation.prepare(snapshot)
            let sections: [NativeTaxPrintSection] = [.header, .yearComparison, .householdBreakdown]
            let pages = NativePagePrintPagesView(printInfo: paper(width: width)) { width in
                sections.map {
                    NativePrintHostingView(
                        rootView: NativeTaxPrintDocument(presentation: presentation, sections: [$0])
                            .frame(width: width)) as NSView
                }
            }
            let rendered = try render(pages)
            let text = rendered.compactMap(\.string).joined(separator: "\n")
            #expect(text.contains("2024"))
            #expect(text.contains(strings.t("tax.householdBreakdown.column.household")))
            expectTextFitsHorizontally(rendered)
            #expect(presentation.snapshot.localState.householdExpanded)
            #expect(presentation.snapshot.year == 2025)
        }

        @Test(arguments: [CGFloat(451), CGFloat(540)])
        func statisticsPivotRendersAllColumnWindowsWithoutNewServiceReads(_ width: CGFloat) async throws {
            let transport = PrintStatisticsTransport()
            let client = APIClient(
                baseURL: { URL(string: "http://127.0.0.1:54332") }, transport: transport, maxRetries: 0)
            let model = StatisticsModel(service: client, now: { Date(timeIntervalSince1970: 1_791_936_000) })
            let screens = StatisticsScreens(
                model: model, saved: SavedChartsModel(service: client), digest: StatisticsDigestModel(service: client))
            let route = NativeRoute("/statistics?tab=categories&window=all")!
            await model.appear(settings: .defaults, route: route)
            try #require(model.hasData, "\(model.error ?? "missing synthetic statistics")")
            let snapshot = try NativeStatisticsPrintSnapshot(
                screens: screens, settings: .defaults, strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark), route: route)
            let reads = await transport.requests
            let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
            let sections = snapshot.sections.filter {
                if case .pivotTable = $0 { return true }
                return false
            }
            #expect(sections.count == 3)
            let pages = NativePagePrintPagesView(printInfo: paper(width: width)) { width in
                sections.map {
                    NativePrintHostingView(
                        rootView: NativeStatisticsPrintDocument(
                            presentation: presentation, sections: [$0], pageWidth: width
                        ).frame(width: width)) as NSView
                }
            }
            let rendered = try render(pages)
            let text = rendered.compactMap(\.string).joined(separator: "\n")
            for month in 1...12 {
                let label = StatisticsPeriodFormat.short(
                    String(format: "2026-%02d", month), locale: LanguageLocale.locale(.en))
                #expect(text.filter { !$0.isWhitespace }.contains(label.filter { !$0.isWhitespace }))
            }
            #expect(text.contains("Synthetic Food"))
            expectTextFitsHorizontally(rendered)
            #expect(await transport.requests == reads)
        }

        @Test func narrowPivotWrapsCompleteLongLabelsAndHighPrecisionAmounts() async throws {
            let label = "Synthetic category with a deliberately long complete printed label"
            let amount = "123456789012345.123456789012"
            let transport = PrintStatisticsTransport(pivotAmount: "-" + amount, categoryName: label)
            let client = APIClient(
                baseURL: { URL(string: "http://127.0.0.1:54332") }, transport: transport, maxRetries: 0)
            let settings = NativeAppSettings(showDecimalPlaces: 12)
            let model = StatisticsModel(service: client, now: { Date(timeIntervalSince1970: 1_791_936_000) })
            let screens = StatisticsScreens(
                model: model, saved: SavedChartsModel(service: client), digest: StatisticsDigestModel(service: client))
            let route = NativeRoute("/statistics?tab=categories&window=all")!
            await model.appear(settings: settings, route: route)
            try #require(model.hasData, "\(model.error ?? "missing synthetic statistics")")
            let snapshot = try NativeStatisticsPrintSnapshot(
                screens: screens, settings: settings, strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark), route: route)
            let reads = await transport.requests
            let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
            let width: CGFloat = 451
            let pages = NativePagePrintPagesView(printInfo: paper(width: width)) { width in
                [
                    NativePrintHostingView(
                        rootView: NativeStatisticsPrintDocument(
                            presentation: presentation, sections: [.pivotTable(0)], pageWidth: width
                        ).frame(width: width))
                ]
            }
            let rendered = try render(pages)
            let page = try #require(rendered.first?.page(at: 0))
            // The page subtitle's period range also starts with January; the table's column
            // header is the lowest occurrence on the page.
            let january = StatisticsPeriodFormat.short("2026-01", locale: LanguageLocale.locale(.en))
            let headerBounds = try #require(NativePDFGlyphs.occurrences(of: january, in: page).last)
            // Read one complete printed column by glyph position so adjacent wrapped numbers
            // cannot interleave in PDFKit's full-page reading order and hide a missing suffix.
            let columnWidth = (width - 32) * 0.75 / 5
            let columnStart = headerBounds.midX - columnWidth / 2
            let printedAmount = NativePDFGlyphs.text(page, from: columnStart, to: headerBounds.midX + columnWidth / 2)
            let expected = MoneyText.text(Decimal(string: amount)!, currency: ReportingFallbackCurrency.euro, settings: settings, signed: false)
            #expect(
                printedAmount.contains(expected.filter { !$0.isWhitespace }),
                "Amount column \(headerBounds): \(printedAmount)\n\(NativePDFGlyphs.layout(page))")
            // The label column is everything left of the first period column.
            let printedLabel = NativePDFGlyphs.text(page, from: 0, to: columnStart)
            #expect(
                printedLabel.contains(label.filter { !$0.isWhitespace }), "Label column: \(printedLabel)")
            expectTextFitsHorizontally(rendered)
            #expect(await transport.requests == reads)
        }

        @Test func netWorthLoadedTableAndChartRenderAcrossPagesWithoutFetchingOrRefreshingPrices() async throws {
            let service = PrintNetWorthService()
            let model = NetWorthModel(service: service, now: { Date(timeIntervalSince1970: 1_791_936_000) })
            await model.load(currency: fixtureCurrency("EUR"), pageSize: 48, route: NativeRoute("/portfolio/net-worth?period=all")!)
            try #require(model.data != nil, "\(model.error ?? "missing synthetic net worth")")
            model.selection = "2026-09-24"
            model.rangeStart = "2026-08-01"
            let snapshot = try NativeNetWorthPrintSnapshot.capture(
                model: model, settings: .defaults, strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark))
            #expect(snapshot.tableRows.count == 48)
            let before = await service.calls
            let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
            model.selection = nil
            model.tableQuery.search = "No matching rows"
            let sections: [NativeNetWorthPrintSection] = [.header, .chart, .table]
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 600)) { width in
                sections.map {
                    NativePrintHostingView(
                        rootView: NativeNetWorthPrintDocument(presentation: presentation, sections: [$0])
                            .frame(width: width)) as NSView
                }
            }
            #expect(pageRange(pages).length > 1)
            let rendered = try render(pages)
            let text = rendered.compactMap(\.string).joined(separator: "\n")
            for row in snapshot.tableRows { #expect(text.contains(presentation.date(row.snapshot.date))) }
            #expect(text.contains("48"))
            expectTextFitsHorizontally(rendered)
            #expect(await service.calls == before)
            #expect(snapshot.selection == "2026-09-24" && snapshot.rangeStart == "2026-08-01")
            #expect(model.tableRows.isEmpty)
        }

        private func paper(width: CGFloat, height: CGFloat = 700) -> NSPrintInfo {
            let info = NSPrintInfo(dictionary: [:])
            info.paperSize = NSSize(width: width + 72, height: height + 72)
            info.leftMargin = 36
            info.rightMargin = 36
            info.topMargin = 36
            info.bottomMargin = 36
            return info
        }
        private func pageRange(_ view: NativePagePrintPagesView) -> NSRange {
            var range = NSRange()
            #expect(view.knowsPageRange(&range))
            return range
        }
        private func render(_ view: NativePagePrintPagesView) throws -> [PDFDocument] {
            try NativePrintPDFRenderer.render(view)
        }
        private func expectTextFitsHorizontally(_ documents: [PDFDocument]) {
            for document in documents {
                guard let page = document.page(at: 0) else { continue }
                let paper = page.bounds(for: .mediaBox)
                for index in 0..<page.numberOfCharacters {
                    let character = page.characterBounds(at: index)
                    guard character.width > 0, character.height > 0 else { continue }
                    #expect(
                        character.minX >= paper.minX - 1 && character.maxX <= paper.maxX + 1,
                        "Printed text exceeds paper width: \(character), paper \(paper)")
                }
            }
        }
        private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
            try JSONDecoder().decode(type, from: Data(json.utf8))
        }
    }

    @MainActor private final class PrintPDFCanvas: NSView {
        override var isFlipped: Bool { true }
    }

    @MainActor private final class MeasuredPrintBlock: NSView {
        let height: CGFloat
        let labels: [(CGFloat, String)]
        override var isFlipped: Bool { true }
        override var fittingSize: NSSize { NSSize(width: frame.width, height: height) }
        init(height: CGFloat, labels: [(CGFloat, String)] = []) {
            self.height = height
            self.labels = labels
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override func draw(_ dirtyRect: NSRect) {
            for (offset, text) in labels {
                (text as NSString).draw(
                    at: NSPoint(x: 12, y: offset),
                    withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.black])
            }
        }
    }
#endif
