import Foundation
import Testing
import VisionNativeCore

@testable import VisionNativeUI

@Suite struct NativeSettingsInsightsQueryTests {
    private func category(_ id: CategoryID, _ path: [String], active: Bool = true) -> OpenAPI.CategoryNode {
        .init(
            id: id, name: path.last ?? "Unnamed", pathIds: [id], path: path, categoryName: path.joined(separator: ":"),
            depth: max(0, path.count - 1), isActive: active, hierarchyOnly: false, legacyCompatible: true)
    }
    private func recipient(_ id: RecipientID, _ name: String, active: Bool = true) -> OpenAPI.Recipient {
        .init(id: id, name: name, isActive: active, createdAt: fixtureInstant("2026-01-01T00:00:00.000Z"), links: [])
    }

    @Test func groupToggleChangesOnlyTheSearchFilteredSubset() {
        let categories = [
            category(1, ["Finance", "Fees"]), category(2, ["Finance", "Interest"]), category(3, ["Travel", "Fees"]),
        ]
        let groups = NativeSettingsInsightsQuery.groups(categories, search: "fees", locale: Locale(identifier: "en_US"))
        #expect(groups.map(\.name) == ["Finance", "Travel"])
        #expect(groups[0].items.map(\.id) == [1])
        #expect(NativeSettingsInsightsQuery.toggledGroup(groups[0].items, excluded: [777, 2]) == [777, 2, 1])
        #expect(NativeSettingsInsightsQuery.toggledGroup(groups[0].items, excluded: [777, 2, 1]) == [777, 2])
    }
    @Test func pathSegmentSearchDoesNotTrimOrMatchAcrossSeparators() {
        let categories = [category(1, ["Finance", "Fees"]), category(2, ["Travel", "Taxi"])]
        #expect(NativeSettingsInsightsQuery.groups(categories, search: "FINANCE").first?.items.map(\.id) == [1])
        #expect(NativeSettingsInsightsQuery.groups(categories, search: " Finance").isEmpty)
        #expect(NativeSettingsInsightsQuery.groups(categories, search: "ce / Fe").isEmpty)
    }
    @Test func hiddenRowsAndUnrelatedExclusionsArePreserved() {
        let items = [category(10, ["Finance", "A"], active: false), category(11, ["Finance", "B"])]
        #expect(NativeSettingsInsightsQuery.groups(items, search: "").first?.items.count == 2)
        #expect(NativeSettingsInsightsQuery.checkState(items, excluded: [999]) == .off)
        #expect(NativeSettingsInsightsQuery.checkState(items, excluded: [999, 10]) == .mixed)
        #expect(NativeSettingsInsightsQuery.toggledGroup(items, excluded: [999, 10]) == [999, 10, 11])
        #expect(NativeSettingsInsightsQuery.checkState(items, excluded: [999, 10, 11]) == .on)
        #expect(NativeSettingsInsightsQuery.toggledGroup(items, excluded: [999, 10, 11]) == [999])
    }
    @Test func recipientSearchSortsExcludedFirstWithoutDroppingHiddenRows() {
        let recipients = [recipient(1, "Alpha"), recipient(2, "Zebra", active: false), recipient(3, "Bravo")]
        #expect(
            NativeSettingsInsightsQuery.recipients(
                recipients, search: "", excluded: [2], locale: Locale(identifier: "en_US")
            ).map(\.id) == [2, 1, 3])
        #expect(NativeSettingsInsightsQuery.recipients(recipients, search: "RA", excluded: [2]).map(\.id) == [2, 3])
        #expect(NativeSettingsInsightsQuery.recipients(recipients, search: " Zebra", excluded: [2]).isEmpty)
    }
    @Test func recipientContractKeepsOnlyTheFirstThousandAndStableTies() {
        var recipients = (1...1001).map { recipient(RecipientID(rawValue: $0), "Same") }
        recipients[1000] = recipient(1001, "First", active: false)
        let visible = NativeSettingsInsightsQuery.recipients(
            recipients, search: "", excluded: [1001], locale: Locale(identifier: "nl_BE"))
        #expect(visible.count == 1000)
        #expect(visible.first?.id == 1)
        #expect(visible.last?.id == 1000)
        #expect(NativeSettingsInsightsQuery.recipients(recipients, search: "First", excluded: [1001]).isEmpty)
    }
}
