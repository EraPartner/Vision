import Foundation

/// Keeps the rows a `LocalTableQuery` produced (searched, filtered and sorted) while the source
/// rows, the query and the caller's context are unchanged. A table asks for its rows on every
/// body pass, and searching and sorting a few thousand rows costs far more than comparing the
/// inputs: equal arrays compare in O(1) while they share a buffer.
public final class LocalTableMemo<Source: Equatable, Context: Equatable, Row> {
    private var source: Source?
    private var context: Context?
    private var query: LocalTableQuery?
    private var result: [Row] = []
    /// How often the rows were rebuilt, for tests.
    public private(set) var builds = 0

    public init() {}

    public func rows(source: Source, context: Context, query: LocalTableQuery, make: () -> [Row]) -> [Row] {
        if let cachedSource = self.source, let cachedContext = self.context, let cachedQuery = self.query,
            cachedQuery == query, cachedContext == context, cachedSource == source
        {
            return result
        }
        let made = make()
        self.source = source
        self.context = context
        self.query = query
        result = made
        builds += 1
        return made
    }
}
