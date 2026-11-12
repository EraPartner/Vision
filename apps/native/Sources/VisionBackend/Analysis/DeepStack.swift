import Foundation
import Synchronization

/// Runs recursive work on a thread with a stack of its own.
///
/// The formula parser descends once per nested parenthesis or unary sign, and an expression may
/// hold a thousand of them inside its length limit. The TypeScript engine parses that on the
/// JavaScript stack; a Swift task runs on a pool thread whose stack is 512 KB on macOS, which
/// such an expression overflows. The caller waits for the result.
enum DeepStack {
    private final class Outcome<Value: Sendable>: Sendable {
        let result = Mutex<Result<Value, any Error>?>(nil)
    }

    static func run<Value: Sendable>(megabytes: Int = 16, _ body: @escaping @Sendable () throws -> Value) throws -> Value {
        let outcome = Outcome<Value>()
        let done = DispatchSemaphore(value: 0)
        let thread = Thread {
            let result = Result { try body() }
            outcome.result.withLock { $0 = result }
            done.signal()
        }
        thread.stackSize = megabytes * 1024 * 1024
        thread.start()
        done.wait()
        guard let result = outcome.result.withLock({ $0 }) else { throw CancellationError() }
        return try result.get()
    }
}
