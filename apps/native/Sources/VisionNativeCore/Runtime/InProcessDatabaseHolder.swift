import Foundation

/// A database connection the app opens besides the Bun backend's: the in-process Swift
/// backend's (ADR-270). `NativeRuntime` treats it as a second writer of the database file:
/// it suspends the connection whenever it stops Bun (snapshot, restore, database switch,
/// quit) and resumes it on the live file once Bun runs again.
public protocol InProcessDatabaseHolder: Sendable {
    /// Closes the connection and refuses work until `resume`. Returns once no statement runs.
    func suspend() async
    /// Allows work again; the connection opens `databasePath` on its next use, and serves
    /// attachments rooted at `attachmentsDirectory` (nil: none configured).
    func resume(databasePath: String, attachmentsDirectory: String?) async
    /// `resume`, computing business dates in `timeZone`: the IANA zone the Bun backend runs
    /// with as `APP_TIMEZONE`, so both writers agree on "today" (nil: keep the current zone).
    func resume(databasePath: String, attachmentsDirectory: String?, timeZone: String?) async
}
