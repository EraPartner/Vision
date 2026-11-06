extension SQLiteConnection {
    /// Registers the SQL functions every Vision connection has (`registerFunctions` in
    /// apps/node-backend/src/database/sqlite/functions.ts). Vision's schema calls them from
    /// CHECK constraints and triggers, so a connection must register them before it writes.
    ///
    /// Phase 6b-1 (ADR-270) ports the NUMERIC functions; the date, text, jsonb, full-text,
    /// sequence and math functions follow before any operation moves to Swift.
    public func registerVisionFunctions() throws {
        try registerNumericFunctions()
    }
}
