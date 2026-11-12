import Foundation
import JavaScriptCore

/// JavaScript's `RegExp`, for user-written patterns (ADR-270). The TypeScript backend runs on
/// Bun, whose engine is JavaScriptCore, so compiling and testing a pattern here gives the same
/// syntax, the same matches and the same `SyntaxError` messages. Swift's own regex engines
/// read a different dialect.
///
/// One context serves every call, under a lock; patterns are compiled per call, as the
/// TypeScript code builds a fresh `RegExp` for each validation and preview.
// lint:allow unchecked-sendable every access to the engine holds the lock
final class JavaScriptRegExp: @unchecked Sendable {
    static let shared = JavaScriptRegExp()

    private final class Engine {
        let context: JSContext
        let compile: JavaScriptCore.JSValue
        let testAll: JavaScriptCore.JSValue
        let redosRisk: JavaScriptCore.JSValue

        init() {
            // lint:allow force-unwrap JSContext() returns nil only when JavaScriptCore itself is unusable
            context = JSContext()!
            context.evaluateScript(Self.source)
            compile = context.objectForKeyedSubscript("visionCompile")
            testAll = context.objectForKeyedSubscript("visionTestAll")
            redosRisk = context.objectForKeyedSubscript("visionHasRedosRisk")
        }

        /// `hasRedosRisk` of `recipientPatternService.ts` verbatim, plus the compile and test
        /// helpers.
        static let source = #"""
            function visionCompile(pattern, flags) {
              try { new RegExp(pattern, flags); return null; }
              catch (err) { return err instanceof Error ? err.message : String(err); }
            }
            function visionTestAll(pattern, flags, inputs, upper) {
              const re = new RegExp(pattern, flags);
              return inputs.map((input) => re.test(upper ? input.toUpperCase() : input));
            }
            function visionHasRedosRisk(pattern) {
              const stripped = pattern.replace(/\[(?:[^\]\\]|\\.)*\]/g, '[]');
              if (/\((?:[^()]*[+*][^()]*)\)[+*{?]/.test(stripped)) return true;
              if (/\((?:[^()]*\|[^()]*)\)[+*{]/.test(stripped)) return true;
              return false;
            }
            """#
    }

    private let lock = NSLock()
    private var engine: Engine?

    private func withEngine<T>(_ body: (Engine) -> T) -> T {
        lock.withLock {
            let current = engine ?? Engine()
            engine = current
            return body(current)
        }
    }

    /// `new RegExp(pattern, flags)`: nil when it compiles, else the `SyntaxError` message.
    func compileError(_ pattern: String, flags: String) -> String? {
        withEngine { engine in
            let result = engine.compile.call(withArguments: [pattern, flags])
            guard let result, !result.isNull, !result.isUndefined else { return nil }
            return result.toString()
        }
    }

    /// `re.test(input)` for each input (upper-cased first with `toUpperCase()` when asked).
    /// A pattern that does not compile matches nothing.
    func test(_ pattern: String, flags: String, _ inputs: [String], upperCased: Bool) -> [Bool] {
        guard compileError(pattern, flags: flags) == nil else { return inputs.map { _ in false } }
        return withEngine { engine in
            let result = engine.testAll.call(withArguments: [pattern, flags, inputs, upperCased])
            return (result?.toArray() ?? []).map { ($0 as? Bool) ?? false }
        }
    }

    /// `hasRedosRisk`.
    func hasRedosRisk(_ pattern: String) -> Bool {
        withEngine { engine in engine.redosRisk.call(withArguments: [pattern])?.toBool() ?? false }
    }
}
