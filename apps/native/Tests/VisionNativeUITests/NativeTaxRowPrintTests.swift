#if canImport(AppKit)
    import AppKit
    import PDFKit
    import SwiftUI
    import Testing
    import VisionNativeCore
    @testable import VisionNativeUI

    @MainActor @Suite("Frozen Tax table rows and repeated print headers")
    struct NativeTaxRowPrintTests {
        @Test(arguments: [NativeLanguage.en, .nl])
        func expandedHouseholdKeepsVariableHeightRowsWholeAndFooterOnce(_ language: NativeLanguage) async throws {
            let presentation = try await makePresentation(language: language)
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 470)) { width in
                NativeTaxPrintDocument.printBlocks(
                    presentation: presentation, width: width, sections: [.householdBreakdown])
            }
            let rows = matching(pages, prefix: "tax.household.row.")
            #expect(rows.count == 27)
            #expect(Set(rows.map { Int($0.frame.height.rounded()) }).count > 1)
            assertWholeRows(rows, in: pages)
            let headers = matching(pages, exact: "tax.household.header")
            #expect(headers.count > 1)
            let footer = try #require(matching(pages, exact: "tax.household.footer").first)
            #expect(matching(pages, exact: "tax.household.footer").count == 1)
            assertWholeRows([footer], in: pages)
            let finalRow = try #require(matching(pages, exact: "tax.household.row.26").first)
            #expect(pageContaining(finalRow, in: pages) == pageContaining(footer, in: pages))

            let rendered = try render(pages)
            for index in 0..<24 {
                let first = String(format: "R%03dA", index)
                let last = String(format: "R%03dZ", index)
                let rowPages = rendered.filter { $0.string?.contains(first) == true }
                #expect(rowPages.count == 1)
                #expect(rowPages.first?.string?.contains(last) == true)
            }
            let strings = presentation.snapshot.strings
            let columnHeader = strings.t("tax.householdBreakdown.column.household")
            for row in rows {
                let index = pageContaining(row, in: pages) - 1
                #expect(rendered[index].string?.contains(columnHeader) == true)
            }
            let allText = rendered.compactMap(\.string).joined(separator: "\n")
            let normalizedText = normalized(allText)
            let note = normalized(strings.t("tax.householdBreakdown.recorded.note"))
            #expect(normalizedText.components(separatedBy: note).count == 2)
            #expect(allText.contains(presentation.snapshot.overview.result.assessment.legalBasis))
            #expect(presentation.snapshot.year == 2025 && presentation.snapshot.localState.householdExpanded)
        }

        @Test(arguments: [NativeLanguage.en, .nl])
        func expandedPITRepeatsHeadersAndKeepsBracketNotesWithTheirRows(_ language: NativeLanguage) async throws {
            let presentation = try await makePresentation(language: language)
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 400)) { width in
                NativeTaxPrintDocument.printBlocks(presentation: presentation, width: width, sections: [.pitBreakdown])
            }
            let rows = matching(pages, prefix: "tax.pit.row.")
            #expect(rows.count == 16)
            assertWholeRows(rows, in: pages)
            #expect(matching(pages, exact: "tax.pit.header").count > 1)
            let rendered = try render(pages)
            let strings = presentation.snapshot.strings
            for row in rows {
                let index = pageContaining(row, in: pages) - 1
                #expect(rendered[index].string?.contains(strings.t("tax.pit.table.component")) == true)
            }
            for bracket in 1...4 {
                let row = try #require(matching(pages, exact: "tax.pit.row.\(bracket)").first)
                let document = rendered[pageContaining(row, in: pages) - 1]
                #expect(document.string?.contains(strings.t("tax.pit.row.bracket\(bracket)")) == true)
                #expect(document.string?.contains(strings.t("tax.pit.bracketRange\(bracket)")) == true)
            }
            #expect(presentation.snapshot.localState.pitExpanded)
        }

        @Test func comparisonUsesTheCapturedYearAndCollapsedDisclosuresStayCollapsed() async throws {
            let state = NativeTaxPrintLocalState(comparisonYear: 2023)
            let presentation = try await makePresentation(language: .en, localState: state)
            let blocks = NativeTaxPrintDocument.printBlocks(
                presentation: presentation, width: 451,
                sections: [.pitBreakdown, .householdBreakdown, .yearComparison])
            #expect(blocks.count == 3)
            #expect(blocks.filter { $0 is NativePagePrintTableBlock }.count == 1)
            let pages = NativePagePrintPagesView(printInfo: paper(width: 451, height: 400)) { width in
                NativeTaxPrintDocument.printBlocks(
                    presentation: presentation, width: width,
                    sections: [.pitBreakdown, .householdBreakdown, .yearComparison])
            }
            #expect(matching(pages, prefix: "tax.household.row.").isEmpty)
            #expect(matching(pages, prefix: "tax.pit.row.").isEmpty)
            let rows = matching(pages, prefix: "tax.comparison.row.")
            #expect(rows.count == 4)
            assertWholeRows(rows, in: pages)
            let rendered = try render(pages)
            for header in matching(pages, exact: "tax.comparison.header") {
                let text = rendered[pageContaining(header, in: pages) - 1].string ?? ""
                #expect(text.contains("2025") && text.contains("2023"))
            }
            let allText = rendered.compactMap(\.string).joined(separator: "\n")
            #expect(!allText.contains("R000A"))
            #expect(!allText.contains(presentation.snapshot.strings.t("tax.pit.row.bracket1")))
            #expect(presentation.snapshot.localState == state)
        }

        @Test func changedPaperWidthRebuildsAllFrozenColumnsWithoutLosingRows() async throws {
            let presentation = try await makePresentation(language: .nl)
            let info = paper(width: 540, height: 520)
            var widths: [CGFloat] = []
            let pages = NativePagePrintPagesView(printInfo: info) { width in
                widths.append(width)
                return NativeTaxPrintDocument.printBlocks(
                    presentation: presentation, width: width, sections: [.householdBreakdown])
            }
            _ = range(pages)
            info.leftMargin += 89
            _ = range(pages)
            #expect(widths == [540, 451])
            let rows = matching(pages, prefix: "tax.household.row.")
            #expect(rows.count == 27 && rows.allSatisfy { $0.frame.width == 451 })
            assertWholeRows(rows, in: pages)
            #expect(matching(pages, exact: "tax.household.footer").count == 1)
            let text = try render(pages).compactMap(\.string).joined(separator: "\n")
            for index in 0..<24 { #expect(text.contains(String(format: "R%03dZ", index))) }
        }

        private func makePresentation(
            language: NativeLanguage,
            localState: NativeTaxPrintLocalState = .init(
                comparisonYear: 2023, pitExpanded: true, householdExpanded: true)
        ) async throws -> NativeTaxPrintPresentation {
            let overview = try JSONDecoder().decode(
                OpenAPI.BelgianTaxOverview.self, from: Data(NativePrintRenderFixtures.taxOverview.utf8))
            var raw = try #require(
                JSONSerialization.jsonObject(with: Data(NativePrintRenderFixtures.taxDashboard.utf8)) as? [String: Any])
            raw["householdBreakdownRows"] = (0..<24).map { index -> [String: Any] in
                [
                    "key": String(format: "test%03d", index), "tone": index % 3 == 0 ? "total" : "base",
                    "partnerAmounts": ["A": 1000 + index, "B": 2000 + index], "household": 3000 + index,
                ]
            }
            var years = try #require(raw["yearCalculations"] as? [[String: Any]])
            var older = years[1]
            older["year"] = 2023
            older["isFiled"] = false
            older["hasFrozenCalculation"] = true
            years.append(older)
            raw["yearCalculations"] = years
            let data = try JSONDecoder().decode(
                TaxDashboardData.self, from: JSONSerialization.data(withJSONObject: raw))
            let snapshot = try NativeTaxPrintSnapshot(
                overview: overview, dashboard: data, settings: .defaults,
                strings: TaxRowPrintStrings(language: language), theme: .init(appearance: .dark),
                visibleWidgets: ["pitBreakdown", "householdBreakdown", "yearComparison"], localState: localState)
            return try await NativeTaxPrintPresentation.prepare(snapshot)
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
        private func range(_ pages: NativePagePrintPagesView) -> NSRange {
            var result = NSRange()
            #expect(pages.knowsPageRange(&result))
            return result
        }
        private func normalized(_ text: String) -> String {
            text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        }
        private func matching(_ view: NSView, prefix: String? = nil, exact: String? = nil) -> [NSView] {
            let id = view.identifier?.rawValue
            let match = exact.map { id == $0 } ?? prefix.map { id?.hasPrefix($0) == true } ?? false
            return (match ? [view] : []) + view.subviews.flatMap { matching($0, prefix: prefix, exact: exact) }
        }
        private func pageContaining(_ row: NSView, in pages: NativePagePrintPagesView) -> Int {
            let rect = row.convert(row.bounds, to: pages)
            return Int(floor((rect.minY + 0.1) / pages.rectForPage(1).height)) + 1
        }
        private func assertWholeRows(_ rows: [NSView], in pages: NativePagePrintPagesView) {
            for row in rows {
                let rect = row.convert(row.bounds, to: pages)
                let page = pages.rectForPage(pageContaining(row, in: pages)).insetBy(dx: -0.5, dy: -0.5)
                #expect(
                    page.contains(rect), "Tax row crosses a page boundary: \(row.identifier?.rawValue ?? "unknown")")
            }
        }
        private func render(_ pages: NativePagePrintPagesView) throws -> [PDFDocument] {
            _ = NSApplication.shared
            let canvas = TaxRowPrintCanvas(frame: pages.frame)
            canvas.addSubview(pages)
            let window = NSWindow(contentRect: pages.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = canvas
            defer {
                window.contentView = nil
                window.close()
            }
            pages.layoutSubtreeIfNeeded()
            return try (1...range(pages).length).map { index in
                let document = try #require(PDFDocument(data: canvas.dataWithPDF(inside: pages.rectForPage(index))))
                let page = try #require(document.page(at: 0))
                let bounds = page.bounds(for: .mediaBox)
                for character in 0..<page.numberOfCharacters {
                    let rect = page.characterBounds(at: character)
                    guard rect.width > 0, rect.height > 0 else { continue }
                    #expect(rect.minX >= bounds.minX - 1 && rect.maxX <= bounds.maxX + 1)
                }
                return document
            }
        }
    }

    private struct TaxRowPrintStrings: Localizing {
        let language: NativeLanguage
        func t(_ key: String, _ variables: [String: String]) -> String {
            let prefix = "tax.householdBreakdown.row.test"
            if key.hasPrefix(prefix), let index = Int(key.dropFirst(prefix.count)) {
                let extra =
                    index % 2 == 0 ? "" : " with a longer synthetic label wrapping across several complete lines"
                return String(format: "R%03dA", index) + " synthetic household row" + extra + " "
                    + String(format: "R%03dZ", index)
            }
            return CatalogStrings(language: language).t(key, variables)
        }
    }
    @MainActor private final class TaxRowPrintCanvas: NSView {
        override var isFlipped: Bool { true }
    }
#endif
