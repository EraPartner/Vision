import Foundation

/// A database connection the app opens besides the Bun backend's: the in-process Swift
/// backend's (ADR-270). `NativeRuntime` treats it as a second writer of the database file:
/// it suspends the connection whenever it stops Bun (snapshot, restore, database switch,
/// quit) and resumes it on the live file once Bun runs again.
public protocol InProcessDatabaseHolder: Sendable {
    /// Closes the connection and refuses work until `resume`. Returns once no statement runs.
    func suspend() async
    /// Allows work again; the connection opens `databasePath` on its next use.
    func resume(databasePath: String) async
}
