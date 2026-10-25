import Foundation
import Testing
import VisionNativeCore

@testable import VisionNativeUI

@Suite struct NativeSettingsBehaviorCategoryQueryTests {
    private var categories: [OpenAPI.CategoryNode] {
        [
            .init(
                id: 30, name: "Finance", pathIds: [30], path: ["Finance"], categoryName: "Finance", depth: 0,
                isActive: true, hierarchyOnly: true, legacyCompatible: false),
            .init(
                id: 31, name: "Old", parentId: 30, pathIds: [30, 31], path: ["Finance", "Old"],
                categoryName: "Finance:Old", depth: 1,
                isActive: false, hierarchyOnly: false, legacyCompatible: true),
            .init(
                id: 32, name: "Fees", parentId: 30, pathIds: [30, 32], path: ["Finance", "Fees"],
                categoryName: "Finance:Fees", depth: 1,
                isActive: true, hierarchyOnly: false, legacyCompatible: true),
        ]
    }
    @Test func pickerIncludesAssignableActiveAncestorsInTreeOrder() {
        #expect(NativeSettingsBehaviorCategoryQuery.active(categories).map(\.id) == [30, 32])
        #expect(NativeSettingsBehaviorCategoryQuery.label(30, categories: categories) == "Finance")
        #expect(NativeSettingsBehaviorCategoryQuery.label(32, categories: categories) == "Finance / Fees")
    }
    @Test func absentAndHiddenSelectionsStayUnresolvedRatherThanBeingReplaced() {
        #expect(NativeSettingsBehaviorCategoryQuery.label(nil, categories: categories) == nil)
        #expect(NativeSettingsBehaviorCategoryQuery.label(31, categories: categories) == nil)
        #expect(NativeSettingsBehaviorCategoryQuery.label(999, categories: categories) == nil)
        #expect(NativeSettingsBehaviorCategoryQuery.matching(categories, search: "Old").isEmpty)
    }
    @Test func categorySearchMatchesFullPathsAndIdentifiers() {
        #expect(NativeSettingsBehaviorCategoryQuery.matching(categories, search: "finance / FEES").map(\.id) == [32])
        #expect(NativeSettingsBehaviorCategoryQuery.matching(categories, search: "32").map(\.id) == [32])
    }
}
