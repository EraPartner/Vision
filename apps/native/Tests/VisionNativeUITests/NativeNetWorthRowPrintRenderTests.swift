#if canImport(AppKit)
    import AppKit
    import PDFKit
    import SwiftUI
    import Testing
    import VisionNativeCore
    @testable import VisionNativeUI

    @MainActor @Suite("Frozen net-worth row-aware print rendering")
    struct NativeNetWorthRowPrintRenderTests {
        init() throws {
            try NativeAppKitTestApplication.prepare()
        }

        @Test(arguments: [CGFloat(451), CGFloat(540)])
        func historyRepeatsHeadersAndKeepsEveryLoadedRowWholeWithFrozenPartialError(_ width: CGFloat) async throws {
            let service = NetWorthRowPrintService()
            let model = await loaded(service)
            await service.rejectFurtherHistory()
            await model.loadMore()
            model.selection = "2026-09-16"
            model.rangeStart = "2026-08-01"
            let snapshot = try NativeNetWorthPrintSnapshot.capture(
                model: model, settings: .init(showDecimalPlaces: 12), strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark))
            #expect(snapshot.tableRows.count == 18)
            #expect(snapshot.tableTotal == 36 && snapshot.tableHasMore)
            let error = try #require(snapshot.tableError)
            let before = await service.calls
            let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
            model.tableQuery.search = "Synthetic no matching live rows"
            model.selection = nil
            model.period = .month
            let info = paper(width: width, height: 360)
            let pages = NativePagePrintPagesView(printInfo: info) { actualWidth in
                NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: actualWidth)
                    .filter { $0.identifier?.rawValue == "networth-history-table" }
            }
            let rows = identified(in: pages, prefix: "networth-history-").filter {
                $0.identifier?.rawValue != "networth-history-header"
                    && $0.identifier?.rawValue != "networth-history-footer"
            }
            #expect(rows.count == snapshot.tableRows.count)
            expectWholeRows(rows, in: pages)
            let ordered = rows.sorted { $0.convert($0.bounds, to: pages).minY < $1.convert($1.bounds, to: pages).minY }
            #expect(
                ordered.compactMap { $0.identifier?.rawValue } == snapshot.tableRows.map { "networth-history-" + $0.id }
            )
            let headers = identified(in: pages, prefix: "networth-history-header")
            #expect(headers.count > 1)
            #expect(identified(in: pages, prefix: "networth-history-footer").count == 1)
            let documents = try render(pages)
            for row in snapshot.tableRows {
                let date = presentation.date(row.snapshot.date)
                let containing = documents.filter { $0.string?.contains(date) == true }
                #expect(containing.count == 1, "Frozen row date must appear on exactly one page: \(date)")
                #expect(containing.first?.string?.contains(snapshot.strings.t("networth.dailyBreakdown")) == true)
            }
            let text = documents.compactMap(\.string).joined(separator: "\n")
            #expect(normalized(text).contains(normalized(error)))
            #expect(
                normalized(text).contains(
                    normalized(snapshot.strings.t("table.loadedOf", ["loaded": "18", "total": "36"]))))
            #expect(normalized(text).contains(normalized(snapshot.strings.t("table.scrollForMore"))))
            expectTextFits(documents)
            // Layout must remain based on the frozen table even after changed paper.
            info.leftMargin += 30
            _ = pageRange(pages)
            let narrower = try render(pages)
            expectTextFits(narrower)
            #expect(await service.calls == before)
            #expect(snapshot.selection == "2026-09-16" && snapshot.rangeStart == "2026-08-01")
            #expect(snapshot.period == .all && model.tableRows.isEmpty)
        }

        @Test(arguments: [CGFloat(451), CGFloat(540)])
        func longAccountRowsRemainWholeWithRepeatedContextAndOneFrozenTotal(_ width: CGFloat) async throws {
            let service = NetWorthRowPrintService()
            let model = await loaded(service)
            let snapshot = try NativeNetWorthPrintSnapshot.capture(
                model: model, settings: .defaults, strings: CatalogStrings(language: .nl),
                theme: .init(appearance: .dark))
            let accounts = try #require(snapshot.accounts)
            let before = await service.calls
            let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
            let pages = NativePagePrintPagesView(printInfo: paper(width: width, height: 360)) { actualWidth in
                NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: actualWidth)
                    .filter { $0.identifier?.rawValue == "networth-accounts-table" }
            }
            let rows = identified(in: pages, prefix: "networth-account-")
            #expect(rows.count == accounts.count)
            expectWholeRows(rows, in: pages)
            let heights = rows.map { $0.bounds.height }
            #expect((heights.max() ?? 0) - (heights.min() ?? 0) > 10)
            #expect(identified(in: pages, prefix: "networth-accounts-header").count > 1)
            let footers = identified(in: pages, prefix: "networth-accounts-footer")
            #expect(footers.count == 1)
            let documents = try render(pages)
            for account in accounts where account.accountId != nil {
                let identifier = String(format: "%03d", account.accountId!)
                let containing = documents.filter { $0.string?.contains("StartAccount" + identifier) == true }
                #expect(containing.count == 1)
                #expect(containing.first?.string?.contains("EndAccount" + identifier) == true)
                let pageText = normalized(containing.first?.string ?? "")
                let accountTitle = normalized(snapshot.strings.t("networth.byAccount.title"))
                #expect(pageText.contains(accountTitle))
            }
            let text = documents.compactMap(\.string).joined(separator: "\n")
            #expect(normalized(text).contains(normalized(snapshot.strings.t("networth.byAccount.unassigned"))))
            #expect(normalized(text).contains(normalized(snapshot.strings.t("networth.byAccount.unassignedHint"))))
            #expect(normalized(text).contains(normalized(snapshot.strings.t("networth.byAccount.displayedTotal"))))
            #expect(normalized(text).contains(normalized(snapshot.strings.t("networth.byAccount.differenceHint"))))
            let accountTotal = try #require(snapshot.accountTotal)
            #expect(normalized(text).contains(normalized(presentation.money(accountTotal))))
            expectTextFits(documents)
            #expect(await service.calls == before)
        }

        @Test func historyColumnsKeepCompleteHighPrecisionAmountsWithoutPageDependentSizing() async throws {
            let service = NetWorthRowPrintService()
            let model = await loaded(service)
            let snapshot = try NativeNetWorthPrintSnapshot.capture(
                model: model, settings: .init(showDecimalPlaces: 12), strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark))
            let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
            let width: CGFloat = 451
            let blocks = NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: width)
            let table = try #require(
                blocks.first { $0.identifier?.rawValue == "networth-history-table" } as? NativePagePrintTableBlock)
            let first = table.rows[0].makeView(width)
            let last = table.rows[table.rows.count - 1].makeView(width)
            let header = table.header.makeView(width)
            let pages = NativePagePrintPagesView(printInfo: paper(width: width, height: 1000)) { _ in
                [header, first, last]
            }
            let documents = try render(pages)
            let document = try #require(documents.first)
            let page = try #require(document.page(at: 0))
            let liquidHeader = try #require(
                document.findString(
                    snapshot.strings.t("networth.liquid").components(separatedBy: " ").last ?? "", withOptions: []
                ).first)
            let dateHeader = try #require(
                document.findString(snapshot.strings.t("networth.date"), withOptions: []).first)
            let nextHeader = try #require(
                document.findString(snapshot.strings.t("networth.liabilities"), withOptions: []).first)
            // Use the rendered column centers rather than independently deriving widths.
            let center = liquidHeader.bounds(for: page).midX
            let left = max(0, (dateHeader.bounds(for: page).maxX + liquidHeader.bounds(for: page).minX) / 2 - 8)
            let right = (liquidHeader.bounds(for: page).maxX + nextHeader.bounds(for: page).minX) / 2
            #expect(left < center && center < right)
            let selection = try #require(
                page.selection(
                    for: NSRect(x: left, y: 0, width: right - left, height: page.bounds(for: .mediaBox).height))?.string
            )
            for row in [snapshot.tableRows[0], snapshot.tableRows[snapshot.tableRows.count - 1]] {
                #expect(normalized(selection).contains(normalized(presentation.money(row.snapshot.liquid))))
            }
            expectTextFits(documents)
        }

        @Test func unavailableAccountsAndPricesStayFrozenOrdinarySections() async throws {
            let service = NetWorthRowPrintService(unavailableAccounts: true, unavailablePrices: true)
            let model = await loaded(service)
            let snapshot = try NativeNetWorthPrintSnapshot.capture(
                model: model, settings: .defaults, strings: CatalogStrings(language: .en),
                theme: .init(appearance: .dark))
            #expect(snapshot.accounts == nil && snapshot.accountsError != nil)
            let error = try #require(snapshot.pricesError)
            let before = await service.calls
            let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
            let blocks = NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: 451)
            #expect(blocks.compactMap { $0 as? NativePagePrintTableBlock }.count == 1)
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 700)) { width in
                NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: width).filter {
                    ["networth-section-accounts", "networth-section-pricesError"].contains(
                        $0.identifier?.rawValue ?? "")
                }
            }
            let text = try render(pages).compactMap(\.string).joined(separator: "\n")
            #expect(text.contains(snapshot.strings.t("networth.byAccount.unavailable")))
            #expect(normalized(text).contains(normalized(error)))
            #expect(await service.calls == before)
        }

        private func loaded(_ service: NetWorthRowPrintService) async -> NetWorthModel {
            let model = NetWorthModel(service: service, now: { Date(timeIntervalSince1970: 1_791_936_000) })
            await model.load(currency: "EUR", pageSize: 18, route: NativeRoute("/portfolio/net-worth?period=all")!)
            return model
        }
        private func normalized(_ value: String) -> String { value.filter { !$0.isWhitespace } }
        private func identified(in root: NSView, prefix: String) -> [NSView] {
            (root.identifier?.rawValue.hasPrefix(prefix) == true ? [root] : [])
                + root.subviews.flatMap { identified(in: $0, prefix: prefix) }
        }
        private func expectWholeRows(_ rows: [NSView], in pages: NativePagePrintPagesView) {
            let height = pages.rectForPage(1).height
            for row in rows {
                let frame = row.convert(row.bounds, to: pages)
                let number = Int(floor((frame.minY + 0.01) / height)) + 1
                #expect(
                    pages.rectForPage(number).insetBy(dx: -0.1, dy: -0.1).contains(frame),
                    "Row crosses printable page: \(row.identifier?.rawValue ?? "")")
            }
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
        private func pageRange(_ view: NativePagePrintPagesView) -> NSRange {
            var range = NSRange()
            #expect(view.knowsPageRange(&range))
            return range
        }
        private func render(_ view: NativePagePrintPagesView) throws -> [PDFDocument] {
            try NativePrintPDFRenderer.render(view)
        }
        private func expectTextFits(_ documents: [PDFDocument]) {
            for document in documents {
                guard let page = document.page(at: 0) else { continue }
                let paper = page.bounds(for: .mediaBox)
                for index in 0..<page.numberOfCharacters {
                    let character = page.characterBounds(at: index)
                    guard character.width > 0 && character.height > 0 else { continue }
                    #expect(character.minX >= paper.minX - 1 && character.maxX <= paper.maxX + 1)
                    #expect(character.minY >= paper.minY - 1 && character.maxY <= paper.maxY + 1)
                }
            }
        }
    }

    @MainActor private final class NetWorthRowPrintCanvas: NSView {
        override var isFlipped: Bool { true }
    }

    private actor NetWorthRowPrintService: NetWorthService {
        private(set) var calls: [String] = []
        private var rejectMore = false
        private let unavailableAccounts: Bool
        private let unavailablePrices: Bool
        init(unavailableAccounts: Bool = false, unavailablePrices: Bool = false) {
            self.unavailableAccounts = unavailableAccounts
            self.unavailablePrices = unavailablePrices
        }
        func rejectFurtherHistory() { rejectMore = true }
        func netWorth(currency: String, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
            calls.append("history:\(limit ?? -1):\(offset ?? 0)")
            if rejectMore, limit != nil, (offset ?? 0) > 0 {
                throw NSError(
                    domain: "Synthetic row-print table", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Synthetic next history page unavailable"])
            }
            let rows: [OpenAPI.NetWorthSnapshot] = (0..<36).map { index in
                .init(
                    date: String(format: "2026-%02d-%02d", index < 20 ? 8 : 9, index % 20 + 1),
                    liquid: Decimal(string: "\(100 + index)123456789012.123456789012")!, liabilities: 10,
                    investments: 947, netWorth: Decimal(1000 + index))
            }
            let visible = limit.map { Array(rows.reversed().dropFirst(offset ?? 0).prefix($0)) } ?? rows
            return .init(
                current: .init(liquid: 100, liabilities: 10, investments: 947, netWorth: 1037, currency: currency),
                monthlyChange: 24, monthlyChangePercent: 2, snapshots: visible,
                snapshotsTotal: limit == nil ? nil : 36, snapshotsLimit: limit, snapshotsOffset: offset)
        }
        func netWorthAccounts() async throws -> [OpenAPI.Account] {
            calls.append("accounts")
            if unavailableAccounts { throw APIError.backendUnavailable }
            return (1...12).map { id in
                let token = String(format: "%03d", id)
                let details =
                    id.isMultiple(of: 2)
                    ? "Synthetic account with a deliberately long complete label and additional ownership details that require several printed lines"
                    : "Synthetic account"
                return .init(
                    id: id, name: "StartAccount\(token) \(details) EndAccount\(token)", currency: "EUR",
                    type: "checking",
                    liquidityClass: "cash", spendable: true, inNetWorth: true, taxWrapper: "none", owner: "joint",
                    multiCurrencyCash: false, hasCashSleeve: false, computedBalance: Decimal(1000 + id),
                    isActive: true, createdAt: "2026-01-01", updatedAt: "2026-01-01")
            }
        }
        func netWorthPartitions(currency: String) async throws -> NetWorthPartitions {
            calls.append("partitions")
            let rows =
                (1...12).map { "{\"account_id\":\($0),\"currentValue\":200}" }
                + ["{\"account_id\":null,\"currentValue\":50}"]
            return try JSONDecoder().decode(
                NetWorthPartitions.self,
                from: Data("{\"currency\":\"EUR\",\"byAccount\":[\(rows.joined(separator: ","))]}".utf8))
        }
        func netWorthRates() async throws -> OpenAPI.ExchangeRates {
            calls.append("rates")
            return .init(totalRates: 0, rates: [], source: "synthetic", isStale: false)
        }
        func netWorthPrices() async throws -> [NetWorthInvestmentPrice] {
            calls.append("prices")
            if unavailablePrices { throw APIError.backendUnavailable }
            return []
        }
        func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh {
            calls.append("forbidden-price-refresh")
            throw APIError.invalidRequest("Printing cannot refresh prices")
        }
    }
#endif
