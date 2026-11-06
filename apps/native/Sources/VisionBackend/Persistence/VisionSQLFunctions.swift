extension SQLiteConnection {
    /// Registers the SQL functions every Vision connection has (`registerFunctions` in
    /// apps/node-backend/src/database/sqlite/functions.ts). Vision's schema calls them from
    /// CHECK constraints and triggers, so a connection must register them before it writes.
    ///
    /// Phase 6b (ADR-270) ports them group by group: NUMERIC, dates and timestamps, text,
    /// jsonb and math so far; full-text search and sequences follow before any operation moves.
    public func registerVisionFunctions(
        time: SQLTimestamps = SQLTimestamps(), clock: SQLConnectionClock = SQLConnectionClock()
    ) throws {
        try registerNumericFunctions()
        try registerTimestampFunctions(time, clock: clock)
        try registerTextFunctions()
    }
}
