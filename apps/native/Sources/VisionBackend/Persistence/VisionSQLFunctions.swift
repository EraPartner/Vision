extension SQLiteConnection {
    /// Registers the SQL functions every Vision connection has (`registerFunctions` in
    /// apps/node-backend/src/database/sqlite/functions.ts). Vision's schema calls them from
    /// CHECK constraints and triggers, so a connection must register them before it writes.
    ///
    /// The schema's own functions (`registerSchemaFunctions`) come after these.
    public func registerVisionFunctions(
        time: SQLTimestamps = SQLTimestamps(), clock: SQLConnectionClock = SQLConnectionClock()
    ) throws {
        try registerNumericFunctions()
        try registerTimestampFunctions(time, clock: clock)
        try registerTextFunctions()
        try registerSearchFunctions()
    }
}
