import Foundation
import VisionNativeCore

enum NativeSettingsBehaviorCategoryQuery {
    static func active(_ categories: [OpenAPI.CategoryNode]) -> [OpenAPI.CategoryNode] {
        // Active structural ancestors are assignable; hierarchyOnly is not a filter.
        categories.filter(\.isActive)
    }
    static func label(_ id: Int?, categories: [OpenAPI.CategoryNode]) -> String? {
        guard let id, let category = active(categories).first(where: { $0.id == id }) else { return nil }
        return category.path.joined(separator: " / ")
    }
    static func matching(_ categories: [OpenAPI.CategoryNode], search: String) -> [OpenAPI.CategoryNode] {
        let query = search.lowercased()
        return active(categories).filter { category in
            query.isEmpty
                || (category.path.joined(separator: " / ") + " " + String(category.id)).lowercased().contains(query)
        }
    }
}
