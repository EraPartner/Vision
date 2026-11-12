import Foundation
import VisionNativeCore

/// A `categories` row (`categoryRowSchema` of `database/rows/catalog.ts`).
struct CategoryRow: Equatable, Sendable {
    let id: CategoryID
    let general: String
    let detail: String
    let description: String?
    let isActive: Bool
    let createdAt: Instant?
    let updatedAt: Instant
    let parentId: CategoryID?
    let name: String
    let hierarchyOnly: Bool
    let legacyCompatible: Bool
    let pathName: String

    init(_ row: SQLRow) throws {
        id = CategoryID(rawValue: try row.integerId("id"))
        general = try row.text("general")
        detail = try row.text("detail")
        description = try row.optionalText("description")
        isActive = try row.bool("is_active")
        if try row.optionalText("created_at") != nil {
            createdAt = try row.instant("created_at")
        } else {
            createdAt = nil
        }
        updatedAt = try row.instant("updated_at")
        parentId = try CategoryRow.optionalId(row, "parent_id")
        name = try row.text("name")
        hierarchyOnly = try row.bool("hierarchy_only")
        legacyCompatible = try row.bool("legacy_compatible")
        pathName = try row.text("path_name")
    }

    static func optionalId(_ row: SQLRow, _ column: String) throws -> CategoryID? {
        guard try row.optionalInt64(column) != nil else { return nil }
        return CategoryID(rawValue: try row.integerId(column))
    }

    /// `enrichCategory`: the row as `res.json` writes it, plus `category_name`.
    var json: [String: JSONValue] {
        [
            "id": .int(id.rawValue), "general": .string(general), "detail": .string(detail),
            "description": description.map(JSONValue.string) ?? .null, "is_active": .bool(isActive),
            "created_at": createdAt.map { JSONValue.string($0.text) } ?? .null,
            "updated_at": .string(updatedAt.text), "parent_id": parentId.map { JSONValue.int($0.rawValue) } ?? .null,
            "name": .string(name), "hierarchy_only": .bool(hierarchyOnly),
            "legacy_compatible": .bool(legacyCompatible), "path_name": .string(pathName),
            "category_name": .string(pathName),
        ]
    }
}

/// A `CategoryNode` of `categoryHierarchyRepository.ts`: a row joined to `category_paths`.
struct CategoryNode: Equatable, Sendable {
    /// `NODE_SELECT`.
    static let select = """
        SELECT c.id, c.name, c.parent_id, p.ids, p.names, p.path_name, p.depth,
               c.description, c.is_active, c.hierarchy_only, c.legacy_compatible
          FROM categories c
          JOIN category_paths p ON p.id = c.id
        """

    let id: CategoryID
    let name: String
    let parentId: CategoryID?
    let pathIds: [CategoryID]
    let path: [String]
    let pathName: String
    let depth: Int
    let description: String?
    let isActive: Bool
    let hierarchyOnly: Bool
    let legacyCompatible: Bool

    init(_ row: SQLRow) throws {
        id = CategoryID(rawValue: try row.integerId("id"))
        name = try row.text("name")
        parentId = try CategoryRow.optionalId(row, "parent_id")
        let ids = try row.text("ids")
        let names = try row.text("names")
        guard case .array(let idValues)? = JSValue.parse(ids), case .array(let nameValues)? = JSValue.parse(names)
        else { throw SQLRowDecodingError(column: "ids", problem: "the category path is not a JSON array") }
        pathIds = try idValues.map { value in
            guard case .number(let number) = value, let id = Int(exactly: number) else {
                throw SQLRowDecodingError(column: "ids", problem: "has a non-integer id")
            }
            return CategoryID(rawValue: id)
        }
        path = try nameValues.map { value in
            guard let text = value.stringValue else {
                throw SQLRowDecodingError(column: "names", problem: "has a non-string name")
            }
            return text
        }
        pathName = try row.text("path_name")
        depth = try row.integerId("depth")
        description = try row.optionalText("description")
        isActive = try row.bool("is_active")
        hierarchyOnly = try row.bool("hierarchy_only")
        legacyCompatible = try row.bool("legacy_compatible")
    }

    /// `mapNode` as `res.json` writes it.
    var json: JSONValue {
        .object([
            "id": .int(id.rawValue), "name": .string(name), "parentId": parentId.map { JSONValue.int($0.rawValue) } ?? .null,
            "pathIds": .array(pathIds.map { JSONValue.int($0.rawValue) }), "path": .array(path.map(JSONValue.string)),
            "category_name": .string(pathName), "depth": .int(depth),
            "description": description.map(JSONValue.string) ?? .null, "is_active": .bool(isActive),
            "hierarchyOnly": .bool(hierarchyOnly), "legacyCompatible": .bool(legacyCompatible),
        ])
    }

    /// `compareNamePaths`: PostgreSQL's text[] order in the C collation, code point by code
    /// point, a shorter prefix first.
    static func comparePaths(_ a: [String], _ b: [String]) -> Int {
        for (x, y) in zip(a, b) where x != y {
            let xs = Array(x.unicodeScalars)
            let ys = Array(y.unicodeScalars)
            for (p, q) in zip(xs, ys) where p != q { return Int(p.value) - Int(q.value) }
            return xs.count - ys.count
        }
        return a.count - b.count
    }
}

/// `routes/categories.ts`, `repositories/categoryHierarchyRepository.ts` and
/// `repositories/categoryRepository.ts` for the operations the app calls: the hierarchy tree,
/// its create, update, delete and merge, and the legacy list and create-or-get. The single
/// category reads and writes by id and the recipient assignment are not in the generated
/// client, so they stay on Bun.
///
/// The hierarchy writes call `scheduleRefresh()`, which refills the dashboard aggregate tables
/// (`MaterializedViewRefresher`). The `/api/info` caches it clears re-validate on
/// `PRAGMA data_version` (ADR-270 decision 4).
enum CategoriesArea {
    static func register(
        _ backend: inout InProcessBackend, database: BackendDatabase, views: MaterializedViewRefresher
    ) {
        backend.serve(OpenAPIOperations.GetCategoryTree.self) { _ in
            try await database.run { session in try CategoriesArea.tree(session) }
        }
        backend.serve(OpenAPIOperations.CreateCategoryNode.self) { request in
            let input = try CategoriesArea.parse(nodeCreateSchema, try RequestBody.parseJavaScript(request.body))
            let result = try await database.run { session in try CategoriesArea.createNode(session, input) }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.UpdateCategoryNode.self) { request in
            let (id, raw) = try CategoriesArea.pathId(request)
            let input = try CategoriesArea.parse(nodeUpdateSchema, try RequestBody.parseJavaScript(request.body))
            let result = try await database.run { session in
                try CategoriesArea.updateNode(session, id: id, segment: raw, input)
            }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.DeleteCategoryNode.self) { request in
            let (id, raw) = try CategoriesArea.pathId(request)
            let result = try await database.run { session in
                try CategoriesArea.deleteNode(session, id: id, segment: raw)
            }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.MergeCategoryNode.self) { request in
            let (source, _) = try CategoriesArea.pathId(request)
            let input = try CategoriesArea.parse(nodeMergeSchema, try RequestBody.parseJavaScript(request.body))
            let target = try CategoriesArea.categoryId(input["targetId"])
            if source == target { throw BackendHTTPError.validation("Source and target must differ") }
            let result = try await database.run { session in
                try CategoriesArea.mergeNodes(session, source: source, target: target)
            }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.GetCategories.self) { request in
            let filters = try CategoriesArea.listFilters(request)
            return try await database.run { session in try CategoriesArea.list(session, filters) }
        }
        backend.serve(OpenAPIOperations.CreateCategory.self) { request in
            let input = try CategoriesArea.legacyCreateBody(try RequestBody.parseJavaScript(request.body))
            return try await database.run { session in try CategoriesArea.createOrGet(session, input) }
        }
    }

    // MARK: - Request input

    /// `z.number().int().positive().pipe(CategoryIdSchema)`.
    static let categoryIdField = Zod.checked(
        .number,
        [
            .int,
            ZodCheck(when: nil) { value in
                guard case .number(let number)? = value, !(number > 0) else { return [] }
                return [ZodIssue(message: "Too small: expected number to be >0", continues: true)]
            },
        ])

    /// `z.string().trim().min(1).max(100)`: the trim overwrites before the length checks.
    static let nameField = Zod.checked(
        Zod.transform(.string) { value, _ in value?.stringValue.map { .string(JavaScriptWhitespace.trim($0)) } ?? value },
        [.minLength(1), .maxLength(100)])

    static let descriptionField = Zod.string(max: 500).nullable.optional

    static let nodeCreateSchema = Zod.strictObject([
        ("name", nameField), ("parentId", categoryIdField.nullable.optional), ("description", descriptionField),
    ])

    static let nodeUpdateSchema = Zod.strictObject([
        ("name", nameField.optional), ("parentId", categoryIdField.nullable.optional),
        ("description", descriptionField), ("is_active", Zod.boolean.optional),
    ])

    static let nodeMergeSchema = Zod.strictObject([("targetId", categoryIdField)])

    /// `parseInput`: the parsed object, or the 400 of its issues.
    static func parse(_ schema: Zod, _ body: JSValue?) throws -> JSObject {
        switch schema.parse(body) {
        case .failure(let failure): throw BackendHTTPError.validation(failure.message)
        case .success(let output): return output?.objectValue ?? JSObject()
        }
    }

    /// `validateIdParam` then `assertEntityIdParam`: the id and the raw segment the 404
    /// messages repeat.
    static func pathId(_ request: InProcessRequest) throws -> (CategoryID, String) {
        guard let raw = request.pathParameters["id"], let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("id must be a positive integer")
        }
        return (CategoryID(rawValue: Int(id)), raw)
    }

    /// A parsed `categoryIdField`.
    static func categoryId(_ value: JSValue?) throws -> CategoryID {
        guard case .number(let number)? = value, let id = Int(exactly: number) else {
            throw BackendHTTPError.validation("targetId: Invalid input: expected number, received undefined")
        }
        return CategoryID(rawValue: id)
    }

    /// A parsed nullable id: absent (nil), null (`.some(nil)`), or the id.
    static func optionalCategoryId(_ value: JSValue?) throws -> CategoryID?? {
        guard let value else { return nil }
        if value == .null { return .some(nil) }
        return .some(try categoryId(value))
    }

    /// A parsed nullable string: absent (nil), null (`.some(nil)`), or the text.
    static func optionalText(_ value: JSValue?) -> String?? {
        guard let value else { return nil }
        return .some(value.stringValue)
    }

    // MARK: - Hierarchy

    static func conflict(_ message: String) -> BackendHTTPError {
        BackendHTTPError(
            status: 409, code: "CONFLICT", message: message,
            details: .object(["reason": .string("CATEGORY_HIERARCHY_CONFLICT")]))
    }

    static func readNode(_ session: BackendSession, _ id: CategoryID) throws -> CategoryNode? {
        try session.row("\(CategoryNode.select) WHERE c.id = ?", [id.sqlValue]).map(CategoryNode.init)
    }

    /// The route answers `res.ok(node)`; a node that vanished is `null`.
    static func nodeData(_ node: CategoryNode?) -> JSONValue { node?.json ?? .null }

    /// `listCategoryNodes`: sorted by name path, then id.
    static func tree(_ session: BackendSession) throws -> HandlerResult {
        let nodes = try session.rows(CategoryNode.select).map(CategoryNode.init).sorted { a, b in
            let byPath = CategoryNode.comparePaths(a.path, b.path)
            return byPath != 0 ? byPath < 0 : a.id.rawValue < b.id.rawValue
        }
        return HandlerResult(data: .object(["items": .array(nodes.map(\.json)), "total": .int(nodes.count)]))
    }

    static func requireActiveParent(_ session: BackendSession, _ parent: CategoryID) throws {
        guard let row = try session.row("SELECT id, is_active FROM categories WHERE id = ?", [parent.sqlValue]) else {
            throw BackendHTTPError.validation("Parent category does not exist")
        }
        if !(try row.bool("is_active")) {
            throw BackendHTTPError.validation("An inactive category cannot be a parent")
        }
    }

    static func upsertRootAlias(_ session: BackendSession, _ general: String, _ target: CategoryID) throws {
        _ = try session.rows(
            """
            INSERT INTO category_root_aliases (general, target_category_id) VALUES (?, ?)
            ON CONFLICT (general) DO UPDATE SET target_category_id = excluded.target_category_id
            """, [.text(general), target.sqlValue])
    }

    /// The hierarchy name rule after the schema: upper case, 1 to 100 UTF-16 units.
    static func normalizedName(_ name: String) throws -> String {
        let normalized = JavaScriptWhitespace.trim(name).uppercased()
        if normalized.isEmpty || normalized.utf16.count > 100 {
            throw BackendHTTPError.validation("Category name must contain 1 to 100 characters")
        }
        return normalized
    }

    /// The SQLSTATE of a database error is `code`.
    static func isCode(_ error: any Error, _ codes: String...) -> Bool {
        guard let found = (error as? DatabaseError)?.code else { return false }
        return codes.contains(found)
    }

    /// `createCategoryNode`: 201 with the new node.
    static func createNode(_ session: BackendSession, _ input: JSObject) throws -> HandlerResult {
        let normalized = try normalizedName(input["name"]?.stringValue ?? "")
        let parent = try optionalCategoryId(input["parentId"]) ?? nil
        let description = optionalText(input["description"]) ?? nil
        let node = try session.transaction { () throws -> CategoryNode? in
            if let parent {
                try requireActiveParent(session, parent)
            } else if try session.row(
                "SELECT 1 AS reserved FROM category_root_aliases WHERE general = ? LIMIT 1", [.text(normalized)]) != nil
            {
                throw conflict("This root name is reserved by a legacy category redirect")
            }
            // The row's `general` embeds its id, so the next AUTOINCREMENT value is drawn first;
            // the transaction holds the write lock.
            guard
                let next = try session.row(
                    """
                    SELECT max(
                             COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'categories'), 0),
                             COALESCE((SELECT max(id) FROM categories), 0)
                           ) + 1 AS id
                    """)
            else { throw SQLRowDecodingError(column: "id", problem: "no category next id") }
            let id = CategoryID(rawValue: try next.integerId("id"))
            do {
                _ = try session.rows(
                    """
                    INSERT INTO categories (id, general, detail, name, parent_id, description, hierarchy_only,
                      legacy_compatible) VALUES (?, ?, ?, ?, ?, ?, 0, 0)
                    """,
                    [
                        id.sqlValue, .text("__HIERARCHY_\(id.rawValue)"), .text(normalized), .text(normalized),
                        parent?.sqlValue ?? .null, description.map(SQLValue.text) ?? .null,
                    ])
            } catch let error where isCode(error, "23505") {
                throw conflict("A category with this name already exists under the parent")
            }
            return try readNode(session, id)
        }
        return HandlerResult(status: 201, data: nodeData(node))
    }

    /// `updateCategoryNode`: 404 when absent, else the changed node.
    static func updateNode(_ session: BackendSession, id: CategoryID, segment: String, _ input: JSObject) throws
        -> HandlerResult
    {
        let name = input["name"]?.stringValue
        let parentPatch = try optionalCategoryId(input["parentId"])
        let descriptionPatch = optionalText(input["description"])
        let isActive: Bool? = if case .bool(let flag)? = input["is_active"] { flag } else { nil }
        let node = try session.transaction { () throws -> CategoryNode? in
            guard let existing = try session.row("SELECT * FROM categories WHERE id = ?", [id.sqlValue]).map(CategoryRow.init)
            else { return nil }
            if let name {
                let trimmed = JavaScriptWhitespace.trim(name)
                if trimmed.isEmpty || trimmed.utf16.count > 100 {
                    throw BackendHTTPError.validation("Category name must contain 1 to 100 characters")
                }
            }
            let nextParent = parentPatch ?? existing.parentId
            let nextName = name.map { JavaScriptWhitespace.trim($0).uppercased() } ?? existing.name
            if let nextParent { try requireActiveParent(session, nextParent) }
            if isActive == false,
                try session.row(
                    "SELECT id FROM categories WHERE parent_id = ? AND is_active = 1 LIMIT 1", [id.sqlValue]) != nil
            {
                throw conflict("Deactivate or move active children before deactivating a parent")
            }
            let description = descriptionPatch ?? existing.description
            do {
                _ = try session.rows(
                    """
                    UPDATE categories SET name = ?, parent_id = ?, description = ?, is_active = ?, updated_at = now()
                     WHERE id = ?
                    """,
                    [
                        .text(nextName), nextParent?.sqlValue ?? .null, description.map(SQLValue.text) ?? .null,
                        .integer((isActive ?? existing.isActive) ? 1 : 0), id.sqlValue,
                    ])
            } catch let error where isCode(error, "23505") {
                throw conflict("A category with this name already exists under the parent")
            } catch let error where isCode(error, "23514") {
                throw conflict("A category cannot be moved below itself or a descendant")
            }
            if existing.hierarchyOnly {
                if existing.parentId == nil, nextName != existing.name || nextParent != nil {
                    try upsertRootAlias(session, existing.name, id)
                }
                if nextParent == nil, nextName == existing.general {
                    _ = try session.rows(
                        "DELETE FROM category_root_aliases WHERE general = ? AND target_category_id = ?",
                        [.text(existing.general), id.sqlValue])
                } else {
                    try upsertRootAlias(session, existing.general, id)
                }
            }
            return try readNode(session, id)
        }
        guard let node else { throw BackendHTTPError.notFound("Category \(segment) not found") }
        return HandlerResult(data: node.json)
    }

    /// `deleteCategoryNode`: 204, 404 when absent, 409 with children or references.
    static func deleteNode(_ session: BackendSession, id: CategoryID, segment: String) throws -> HandlerResult {
        let deleted = try session.transaction { () throws -> Bool in
            guard try session.row("SELECT id FROM categories WHERE id = ?", [id.sqlValue]) != nil else { return false }
            if try session.row("SELECT id FROM categories WHERE parent_id = ? LIMIT 1", [id.sqlValue]) != nil {
                throw conflict("Move or delete children before deleting their parent")
            }
            do {
                _ = try session.rows("DELETE FROM categories WHERE id = ?", [id.sqlValue])
            } catch let error where isCode(error, "23503", "23001") {
                throw conflict("Category is still referenced or has legacy merge redirects")
            }
            return true
        }
        guard deleted else { throw BackendHTTPError.notFound("Category \(segment) not found") }
        return .noContent
    }

    /// `^[a-z_][a-z0-9_]*$`.
    static func isPlainIdentifier(_ text: String) -> Bool {
        guard let first = text.utf8.first, first == 95 || (97...122).contains(first) else { return false }
        return text.utf8.allSatisfy { $0 == 95 || (97...122).contains($0) || (48...57).contains($0) }
    }

    /// `mergeCategoryNodes`: move every child and direct reference of the source to the target,
    /// keep the redirects, delete the source, and answer the target node.
    static func mergeNodes(_ session: BackendSession, source sourceId: CategoryID, target targetId: CategoryID) throws
        -> HandlerResult
    {
        let node = try session.transaction { () throws -> CategoryNode? in
            let nodes = try session.rows(
                """
                SELECT id, is_active, general, detail, legacy_compatible, hierarchy_only FROM categories
                 WHERE id IN (?, ?) ORDER BY id
                """, [sourceId.sqlValue, targetId.sqlValue])
            guard nodes.count == 2 else { return nil }
            var sourceRow: SQLRow?
            var targetActive = false
            for row in nodes {
                let id = CategoryID(rawValue: try row.integerId("id"))
                if id == targetId { targetActive = try row.bool("is_active") }
                if id == sourceId { sourceRow = row }
            }
            if !targetActive { throw BackendHTTPError.validation("Merge target must be active") }
            guard let sourceRow else {
                throw SQLRowDecodingError(column: "id", problem: "merge source category is missing")
            }
            if try session.row(
                "SELECT 1 AS found FROM category_ancestors WHERE category_id = ? AND ancestor_id = ? LIMIT 1",
                [targetId.sqlValue, sourceId.sqlValue]) != nil
            {
                throw BackendHTTPError.validation("Merge target cannot be inside the source subtree")
            }
            do {
                _ = try session.rows(
                    "UPDATE categories SET parent_id = ? WHERE parent_id = ?", [targetId.sqlValue, sourceId.sqlValue])
                // Every single-column foreign key that references categories, from the schema.
                let references = try session.rows(
                    """
                    SELECT m.name AS table_name, fk."from" AS column_name
                      FROM sqlite_schema m
                      JOIN pragma_foreign_key_list(m.name) fk
                     WHERE m.type = 'table'
                       AND fk."table" = 'categories'
                       AND m.name <> 'categories'
                       AND m.name NOT IN ('category_merge_aliases', 'category_root_aliases')
                       AND (SELECT count(*) FROM pragma_foreign_key_list(m.name) part
                             WHERE part.id = fk.id) = 1
                     ORDER BY m.name, fk."from"
                    """)
                for reference in references {
                    let table = try reference.text("table_name")
                    let column = try reference.text("column_name")
                    guard isPlainIdentifier(table), isPlainIdentifier(column) else {
                        throw conflict("Unsupported category reference identifier")
                    }
                    _ = try session.rows(
                        "UPDATE \"\(table)\" SET \"\(column)\"=? WHERE \"\(column)\"=?",
                        [targetId.sqlValue, sourceId.sqlValue])
                }
                // Redirects through chains such as A -> B -> C stay on the final target.
                _ = try session.rows(
                    "UPDATE category_merge_aliases SET target_category_id = ? WHERE target_category_id = ?",
                    [targetId.sqlValue, sourceId.sqlValue])
                _ = try session.rows(
                    "UPDATE category_root_aliases SET target_category_id = ? WHERE target_category_id = ?",
                    [targetId.sqlValue, sourceId.sqlValue])
                if try sourceRow.bool("legacy_compatible") {
                    _ = try session.rows(
                        """
                        INSERT INTO category_merge_aliases (general, detail, target_category_id) VALUES (?, ?, ?)
                        ON CONFLICT (general, detail) DO UPDATE SET target_category_id = excluded.target_category_id
                        """,
                        [.text(try sourceRow.text("general")), .text(try sourceRow.text("detail")), targetId.sqlValue])
                }
                if try sourceRow.bool("hierarchy_only") {
                    try upsertRootAlias(session, try sourceRow.text("general"), targetId)
                }
                _ = try session.rows("DELETE FROM categories WHERE id = ?", [sourceId.sqlValue])
            } catch let error where isCode(error, "23505") {
                throw conflict(
                    "Merge would duplicate a category membership or sibling name; resolve the conflict first")
            }
            return try readNode(session, targetId)
        }
        guard let node else { throw BackendHTTPError.notFound("Source or target category not found") }
        return HandlerResult(data: node.json)
    }

    // MARK: - GET /api/categories

    struct ListFilters: Sendable {
        var general: String?
        var detail: String?
        var search: String?
        var active: Bool
        var page: PageParams?
    }

    /// `optionalQueryString`: a repeated key is refused.
    static func singleQuery(_ request: InProcessRequest, _ name: String) throws -> String? {
        let values = request.queryItems.filter { $0.name == name }
        if values.count > 1 { throw BackendHTTPError.validation("\(name) must be a single value") }
        return values.first.map { $0.value ?? "" }
    }

    static func listFilters(_ request: InProcessRequest) throws -> ListFilters {
        let active = request.query("active") ?? "true"
        let general = try singleQuery(request, "general")
        let detail = try singleQuery(request, "detail")
        let search = try singleQuery(request, "search")
        let page = PageParams.optional(limit: request.query("limit"), offset: request.query("offset"), maxLimit: 1000)
        // `search.slice(0, 200)`: UTF-16 units.
        let sliced = search.flatMap { $0.isEmpty ? nil : String(decoding: Array($0.utf16.prefix(200)), as: UTF16.self) }
        return ListFilters(
            general: general.flatMap { $0.isEmpty ? nil : $0 }, detail: detail.flatMap { $0.isEmpty ? nil : $0 },
            search: sliced, active: QueryInput.boolean(active, default: true), page: page)
    }

    /// `filterCategories`: legacy-compatible rows, `ilike` (ASCII case folding) on the texts.
    static func filterClause(_ filters: ListFilters) -> (String, [SQLValue]) {
        var clause = " WHERE legacy_compatible = 1"
        var arguments: [SQLValue] = []
        if filters.active { clause += " AND is_active = 1" }
        if let general = filters.general {
            clause += " AND ilike(general, ?)"
            arguments.append(.text("%\(general)%"))
        }
        if let detail = filters.detail {
            clause += " AND ilike(detail, ?)"
            arguments.append(.text("%\(detail)%"))
        }
        if let search = filters.search {
            clause += " AND (ilike(general, ?) OR ilike(detail, ?) OR ilike(path_name, ?) OR ilike(description, ?))"
            arguments += Array(repeating: .text("%\(search)%"), count: 4)
        }
        return (clause, arguments)
    }

    /// `categoryService.getAll` (and `getCount` when paginated), each item with `links`.
    static func list(_ session: BackendSession, _ filters: ListFilters) throws -> HandlerResult {
        let (clause, arguments) = filterClause(filters)
        var pageClause = ""
        var pageArguments: [SQLValue] = []
        if let page = filters.page {
            pageClause = " LIMIT ? OFFSET ?"
            pageArguments = [page.limit.sqlValue, page.offset.sqlValue]
        }
        let rows = try session.rows(
            "SELECT * FROM categories\(clause) ORDER BY general, detail\(pageClause)", arguments + pageArguments
        ).map(CategoryRow.init)
        let total: Int
        if filters.page == nil {
            total = rows.count
        } else {
            guard let count = try session.row("SELECT count(*) AS count FROM categories\(clause)", arguments) else {
                throw SQLRowDecodingError(column: "count", problem: "no category count row")
            }
            total = Int(try count.int64("count"))
        }
        let items = rows.map { row -> JSONValue in
            var item = row.json
            item["links"] = .array([])
            return .object(item)
        }
        var body = listBody(items, total: total, page: filters.page)
        body["links"] = .array([])
        return HandlerResult(data: .object(body))
    }

    // MARK: - POST /api/categories

    struct LegacyCreate: Sendable {
        let general: String
        let detail: String
        let description: String?
    }

    static let legacyCreateSchema = Zod.transform(
        .object(
            [
                ("general", Zod.string.optional), ("detail", Zod.string.optional),
                ("description", Zod.string.nullable.optional),
            ], .strip)
    ) { value, issues in
        let object = value?.objectValue
        let general = object?["general"]?.stringValue ?? ""
        let detail = object?["detail"]?.stringValue ?? ""
        if general.isEmpty || detail.isEmpty {
            issues.append(ZodIssue(message: "Missing required fields: general, detail"))
            return nil
        }
        return value
    }

    /// `parseInput(legacyCreate, req.body ?? {})`.
    static func legacyCreateBody(_ body: JSValue?) throws -> LegacyCreate {
        let object = try parse(legacyCreateSchema, body ?? .object(JSObject()))
        return LegacyCreate(
            general: object["general"]?.stringValue ?? "", detail: object["detail"]?.stringValue ?? "",
            description: object["description"]?.stringValue)
    }

    static func getById(_ session: BackendSession, _ id: CategoryID) throws -> CategoryRow? {
        try session.row("SELECT * FROM categories WHERE id = ?", [id.sqlValue]).map(CategoryRow.init)
    }

    /// `categoryRepository.createOrGet`: a merge redirect, else insert, else the existing row;
    /// 201 when created, else 200.
    static func createOrGet(_ session: BackendSession, _ input: LegacyCreate) throws -> HandlerResult {
        let general = JavaScriptWhitespace.trim(input.general.uppercased())
        let detail = JavaScriptWhitespace.trim(input.detail.uppercased())
        let (category, created) = try session.transaction { () throws -> (CategoryRow?, Bool) in
            if let alias = try session.row(
                "SELECT target_category_id AS id FROM category_merge_aliases WHERE general = ? AND detail = ?",
                [.text(general), .text(detail)])
            {
                return (try getById(session, CategoryID(rawValue: try alias.integerId("id"))), false)
            }
            if let inserted = try session.row(
                """
                INSERT INTO categories (general, detail, description, is_active) VALUES (?, ?, ?, 1)
                ON CONFLICT (general, detail) DO NOTHING RETURNING *
                """, [.text(general), .text(detail), input.description.map(SQLValue.text) ?? .null])
            {
                // An AFTER trigger fills the hierarchy path, so the row is read again.
                return (try getById(session, CategoryID(rawValue: try inserted.integerId("id"))), true)
            }
            let existing = try session.row(
                "SELECT * FROM categories WHERE general = ? AND detail = ?",
                [.text(general.uppercased()), .text(detail.uppercased())]
            ).map(CategoryRow.init)
            return (existing, false)
        }
        var data = category?.json ?? [:]
        data["created"] = .bool(created)
        data["links"] = .array([])
        return HandlerResult(status: created ? 201 : 200, data: .object(data))
    }
}

extension IntIdentifier {
    /// The id bound as an SQL integer.
    var sqlValue: SQLValue { .integer(Int64(rawValue)) }
}
