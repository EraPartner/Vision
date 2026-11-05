import Foundation

/// The API calls of `/categories` (apps/frontend/src/lib/api/categories.ts), so tests can use
/// a fake.
public protocol CategoriesService: Sendable {
    /// `getCategoryTree()`: every node, active or not.
    func categoryTree() async throws -> [OpenAPI.CategoryNode]
    /// `createCategoryNode({ name, parentId, description })`.
    func createCategoryNode(_ body: CategoryNodeBody) async throws
    /// `updateCategoryNode(id, { name, parentId, description })` (the dialog's edit).
    func updateCategoryNode(id: CategoryID, body: CategoryNodeBody) async throws
    /// `updateCategoryNode(id, { is_active })` (Mark inactive / Mark active and their Undo).
    func setCategoryActive(id: CategoryID, isActive: Bool) async throws
    /// `deleteCategoryNode(id)`.
    func deleteCategoryNode(id: CategoryID) async throws
    /// `mergeCategoryNode(sourceId, targetId)`.
    func mergeCategoryNode(sourceId: CategoryID, targetId: CategoryID) async throws
}

/// The body `CategoryNodeDialog` sends on create and edit: `{ name, parentId, description }`
/// with `parentId: null` for a root and `description: null` for an empty description, which
/// the generated bodies (they drop a `nil`) cannot express. On an edit, `parentId: null`
/// moves the node to the root.
public struct CategoryNodeBody: Equatable, Sendable, Encodable {
    public let name: String
    public let parentId: CategoryID?
    public let description: String?

    public init(name: String, parentId: CategoryID?, description: String?) {
        self.name = name
        self.parentId = parentId
        self.description = description
    }

    enum CodingKeys: String, CodingKey {
        case name
        case parentId
        case description
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        if let parentId {
            try container.encode(parentId, forKey: .parentId)
        } else {
            try container.encodeNil(forKey: .parentId)
        }
        if let description {
            try container.encode(description, forKey: .description)
        } else {
            try container.encodeNil(forKey: .description)
        }
    }
}

extension APIClient: CategoriesService {
    public func categoryTree() async throws -> [OpenAPI.CategoryNode] {
        try await send(CategoryTreeRequest()).items
    }

    public func createCategoryNode(_ body: CategoryNodeBody) async throws {
        _ = try await send(CategoryNodeCreateRequest(body: body))
    }

    public func updateCategoryNode(id: CategoryID, body: CategoryNodeBody) async throws {
        _ = try await send(CategoryNodeUpdateRequest(id: id, body: body))
    }

    public func setCategoryActive(id: CategoryID, isActive: Bool) async throws {
        _ = try await send(CategoryNodeStatusRequest(id: id, isActive: isActive))
    }

    public func deleteCategoryNode(id: CategoryID) async throws {
        _ = try await send(OpenAPIOperations.DeleteCategoryNode(id: id))
    }

    public func mergeCategoryNode(sourceId: CategoryID, targetId: CategoryID) async throws {
        _ = try await send(CategoryMergeRequest(sourceId: sourceId, targetId: targetId))
    }
}

// MARK: - Hand-written requests

/// `GET /api/categories/tree` (operationId `getCategoryTree`): the spec names its response
/// `CategoryTreeEnvelope` by `$ref`, which the generator takes for the unwrapped `data`
/// (and then misses `ok`), so this request reads `{ items, total }` itself.
public struct CategoryTreeRequest: APIOperation {
    public static let operationId = OpenAPIOperations.GetCategoryTree.operationId
    public static let method = OpenAPIOperations.GetCategoryTree.method
    public static let pathTemplate = OpenAPIOperations.GetCategoryTree.pathTemplate

    /// `data`: the nodes; an absent list reads as none.
    public struct Response: Decodable, Equatable, Sendable {
        public let items: [OpenAPI.CategoryNode]

        enum CodingKeys: String, CodingKey {
            case items
        }

        public init(items: [OpenAPI.CategoryNode]) {
            self.items = items
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            items = try container.decodeIfPresent([OpenAPI.CategoryNode].self, forKey: .items) ?? []
        }
    }

    public init() {}

    public var path: String { Self.pathTemplate }
}

/// `POST /api/categories/tree` (operationId `createCategoryNode`) with `CategoryNodeBody`.
/// The answer is not read (the web refetches the tree).
public struct CategoryNodeCreateRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.CreateCategoryNode.operationId
    public static let method = OpenAPIOperations.CreateCategoryNode.method
    public static let pathTemplate = OpenAPIOperations.CreateCategoryNode.pathTemplate

    public let body: CategoryNodeBody

    public init(body: CategoryNodeBody) {
        self.body = body
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(body)
    }
}

/// `PATCH /api/categories/tree/{id}` (operationId `updateCategoryNode`) with
/// `CategoryNodeBody`: a rename, a move (`parentId`, `null` for the root) and the description.
public struct CategoryNodeUpdateRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.UpdateCategoryNode.operationId
    public static let method = OpenAPIOperations.UpdateCategoryNode.method
    public static let pathTemplate = OpenAPIOperations.UpdateCategoryNode.pathTemplate

    public let id: CategoryID
    public let body: CategoryNodeBody

    public init(id: CategoryID, body: CategoryNodeBody) {
        self.id = id
        self.body = body
    }

    public var path: String { OpenAPIOperations.UpdateCategoryNode(id: id, body: OpenAPI.CategoryNodeUpdate()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(body)
    }
}

/// `PATCH /api/categories/tree/{id}` with `{ is_active }` (operationId `updateCategoryNode`).
public struct CategoryNodeStatusRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.UpdateCategoryNode.operationId
    public static let method = OpenAPIOperations.UpdateCategoryNode.method
    public static let pathTemplate = OpenAPIOperations.UpdateCategoryNode.pathTemplate

    public let id: CategoryID
    public let isActive: Bool

    public init(id: CategoryID, isActive: Bool) {
        self.id = id
        self.isActive = isActive
    }

    public var path: String { OpenAPIOperations.UpdateCategoryNode(id: id, body: OpenAPI.CategoryNodeUpdate()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(OpenAPI.CategoryNodeUpdate(isActive: isActive))
    }
}

/// `POST /api/categories/tree/{id}/merge` with `{ targetId }` (operationId
/// `mergeCategoryNode`); the surviving node is not read.
public struct CategoryMergeRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.MergeCategoryNode.operationId
    public static let method = OpenAPIOperations.MergeCategoryNode.method
    public static let pathTemplate = OpenAPIOperations.MergeCategoryNode.pathTemplate

    public let sourceId: CategoryID
    public let targetId: CategoryID

    public init(sourceId: CategoryID, targetId: CategoryID) {
        self.sourceId = sourceId
        self.targetId = targetId
    }

    public var path: String {
        OpenAPIOperations.MergeCategoryNode(id: sourceId, body: .init(targetId: targetId)).path
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(OpenAPIOperations.MergeCategoryNode.Body(targetId: targetId))
    }
}
