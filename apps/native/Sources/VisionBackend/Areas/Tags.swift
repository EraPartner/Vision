import Foundation
import VisionNativeCore

/// A `tags` row (`tagRowSchema` of `database/rows/catalog.ts`).
struct TagRow: Equatable, Sendable {
    let id: TagID
    let slug: String
    let color: String?
    let isActive: Bool
    let createdAt: Instant
    let updatedAt: Instant

    init(_ row: SQLRow) throws {
        id = TagID(rawValue: try row.integerId("id"))
        slug = try row.text("slug")
        color = try row.optionalText("color")
        isActive = try row.bool("is_active")
        createdAt = try row.instant("created_at")
        updatedAt = try row.instant("updated_at")
    }

    /// The row as `res.json` writes it.
    var json: [String: JSONValue] {
        [
            "id": .int(id.rawValue), "slug": .string(slug), "color": color.map(JSONValue.string) ?? .null,
            "is_active": .bool(isActive), "created_at": .string(createdAt.text), "updated_at": .string(updatedAt.text),
        ]
    }
}

/// `routes/tags.ts`, `services/tagService.ts` and `repositories/tagRepository.ts` for the
/// operations the app calls: the list and create-or-reactivate. `updateTag` and `deleteTag`
/// are not in the generated client, so they stay on Bun.
///
/// Bun keeps no in-memory cache over `tags` (ADR-270 decision 4). The filtered transaction
/// count cache (2 s) joins tags but is not cleared by the TypeScript tag writes either.
enum TagsArea {
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetTags.self) { request in
            let active = QueryInput.activeOrAll(request.query("active"))
            let page = PageParams.optional(
                limit: request.query("limit"), offset: request.query("offset"), maxLimit: 1000)
            return try await database.run { session in
                try TagsArea.list(session, active: active, page: page)
            }
        }
        backend.serve(OpenAPIOperations.CreateTag.self) { request in
            let body = try TagsArea.createBody(request.body)
            return try await database.run { session in
                try TagsArea.create(session, body)
            }
        }
    }

    // MARK: - GET /api/tags

    static func list(_ session: BackendSession, active: Bool?, page: PageParams?) throws -> HandlerResult {
        var filter = ""
        var arguments: [SQLValue] = []
        if let active {
            filter = " WHERE is_active = ?"
            arguments.append(.integer(active ? 1 : 0))
        }
        var pageClause = ""
        var pageArguments: [SQLValue] = []
        if let page {
            pageClause = " LIMIT ? OFFSET ?"
            pageArguments = [page.limit.sqlValue, page.offset.sqlValue]
        }
        let items = try session.rows("SELECT * FROM tags\(filter) ORDER BY slug\(pageClause)", arguments + pageArguments)
            .map(TagRow.init)
        let total: Int
        if page == nil {
            total = items.count
        } else {
            let count = try session.row("SELECT CAST(COUNT(*) AS TEXT) AS count FROM tags\(filter)", arguments)
            total = try countValue(count, "tag count")
        }
        var body = listBody(items.map { .object($0.json) }, total: total, page: page)
        body["links"] = .array([])
        return HandlerResult(data: .object(body))
    }

    // MARK: - POST /api/tags

    /// `createBody` of the route, then the service's slug rules, into the generated type.
    static func createBody(_ data: Data?) throws -> OpenAPI.TagCreate {
        var issues = InputIssues()
        let object = ObjectInput.parse(try RequestBody.parse(data), issues: &issues)
        let slug = object?.optionalString("slug", issues: &issues)
        let color = object?.nullableString("color", issues: &issues)
        try issues.check()
        guard let slug, !slug.isEmpty else { throw BackendHTTPError.validation("Missing required field: slug") }
        return OpenAPI.TagCreate(slug: slug, color: color)
    }

    /// `createOrReactivate`: 201 for a new or a reactivated inactive tag, 200 for an active
    /// one that already existed.
    static func create(_ session: BackendSession, _ body: OpenAPI.TagCreate) throws -> HandlerResult {
        let slug = slugify(body.slug)
        if slug.isEmpty { throw BackendHTTPError.validation("slug is empty after normalization") }

        let preexisting = try session.row("SELECT * FROM tags WHERE slug = ?", [.text(slug)]).map(TagRow.init)
        let wasInactive = preexisting.map { !$0.isActive } ?? false
        var junctionCount = 0
        if let preexisting, wasInactive {
            let count = try session.row(
                "SELECT CAST(COUNT(*) AS TEXT) AS count FROM transaction_tags WHERE tag_id = ?",
                [.integer(Int64(preexisting.id.rawValue))])
            junctionCount = try countValue(count, "tag reference count")
        }

        // `findOrCreateBySlug`: SQLite has no `xmax`, so the existence read runs first, in
        // the same transaction as the upsert.
        let (tag, reactivated) = try session.transaction { () throws -> (TagRow, Bool) in
            let existing = try session.row("SELECT * FROM tags WHERE slug = ?", [.text(slug)])
            guard
                let row = try session.row(
                    """
                    INSERT INTO tags (slug, color) VALUES (?, ?) ON CONFLICT (slug) DO UPDATE SET is_active = 1, \
                    color = COALESCE(tags.color, EXCLUDED.color), updated_at = now() RETURNING *
                    """,
                    [.text(slug), body.color.map(SQLValue.text) ?? .null])
            else { throw SQLRowDecodingError(column: "tags", problem: "the tag upsert returned no row") }
            let tag = try TagRow(row)
            return (tag, existing != nil && tag.isActive)
        }

        var data = tag.json
        data["reactivated"] = .bool(reactivated)
        if reactivated && wasInactive { data["reactivated_junction_count"] = .int(junctionCount) }
        data["created"] = .bool(!reactivated)
        data["links"] = .array([])
        return HandlerResult(status: reactivated && !wasInactive ? 200 : 201, data: .object(data))
    }

    /// `parseInt(row.count, 10)` of a `CAST(COUNT(*) AS TEXT)` row.
    static func countValue(_ row: SQLRow?, _ what: String) throws -> Int {
        guard let row else { throw SQLRowDecodingError(column: "count", problem: "no \(what) row") }
        guard let count = Int(try row.text("count")) else {
            throw SQLRowDecodingError(column: "count", problem: "\(what) is not an integer")
        }
        return count
    }
}
