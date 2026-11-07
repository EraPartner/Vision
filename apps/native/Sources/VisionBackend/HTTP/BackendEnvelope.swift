import Foundation
import VisionNativeCore

/// An error the TypeScript backend raises as an `AppError` subclass
/// (`middleware/errorHandler.ts`): its status, code and message reach the client.
public struct BackendHTTPError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public let details: JSONValue?

    public init(status: Int, code: String, message: String, details: JSONValue? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.details = details
    }

    /// `ValidationError`.
    public static func validation(_ message: String) -> Self {
        Self(status: 400, code: "VALIDATION_ERROR", message: message)
    }

    /// `NotFoundError`.
    public static func notFound(_ message: String) -> Self {
        Self(status: 404, code: "NOT_FOUND", message: message)
    }

    /// `ConflictError`.
    public static func conflict(_ message: String) -> Self {
        Self(status: 409, code: "CONFLICT", message: message)
    }
}

/// What a handler answers: the status and the success envelope's `data`.
public struct HandlerResult: Sendable, Equatable {
    public let status: Int
    public let data: JSONValue

    public init(status: Int = 200, data: JSONValue) {
        self.status = status
        self.data = data
    }
}

/// The ADR-026 envelope as the data plane's middleware writes it: `requestId`, `wrapResponse`
/// and the production error handler.
enum BackendEnvelope {
    /// `SAFE_REQUEST_ID` of `middleware/requestId.ts`.
    static func isSafeRequestId(_ value: String) -> Bool {
        let scalars = value.unicodeScalars
        guard (8...128).contains(scalars.count) else { return false }
        return scalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", ".", "_", "-": return true
            default: return false
            }
        }
    }

    /// The incoming `X-Request-Id` when it is a safe token, else a new lowercase UUID.
    static func requestId(_ headers: [String: String]) -> String {
        if let incoming = headers.first(where: { $0.key.lowercased() == "x-request-id" })?.value,
            isSafeRequestId(incoming)
        {
            return incoming
        }
        return UUID().uuidString.lowercased()
    }

    static func encode(_ value: JSONValue) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    // lint:allow raw-id the envelope's opaque request correlation token
    static func response(status: Int, body: JSONValue, requestId: String) throws -> APIResponse {
        APIResponse(
            status: status, body: try encode(body),
            headers: ["content-type": "application/json; charset=utf-8", "x-request-id": requestId])
    }

    /// `res.ok(data)`: `{ ok: true, data, meta: { requestId } }`.
    // lint:allow raw-id the envelope's opaque request correlation token
    static func success(_ result: HandlerResult, requestId: String) throws -> APIResponse {
        try response(
            status: result.status,
            body: .object(["ok": .bool(true), "data": result.data, "meta": .object(["requestId": .string(requestId)])]),
            requestId: requestId)
    }

    /// `createErrorHandler(() => true)`: a `BackendHTTPError` keeps its status, code and
    /// message; anything else is a 500 whose message is masked, as the packaged backend runs
    /// in production.
    // lint:allow raw-id the envelope's opaque request correlation token
    static func failure(_ error: any Error, requestId: String) throws -> APIResponse {
        let status: Int
        var fields: [String: JSONValue]
        if let error = error as? BackendHTTPError {
            status = error.status
            fields = ["code": .string(error.code), "message": .string(error.message)]
            if let details = error.details { fields["details"] = details }
        } else {
            status = 500
            fields = [
                "code": .string("INTERNAL_SERVER_ERROR"),
                "message": .string("An internal server error occurred. Please try again later."),
            ]
        }
        return try response(
            status: status,
            body: .object([
                "ok": .bool(false), "error": .object(fields), "meta": .object(["requestId": .string(requestId)]),
            ]),
            requestId: requestId)
    }
}

/// The body of a ported operation: the request in, the status and `data` out.
public typealias BackendOperationBody = @Sendable (InProcessRequest) async throws -> HandlerResult

extension InProcessBackend {
    /// Serves `Operation` behind the data plane's envelope: a thrown `BackendHTTPError`
    /// becomes its failure envelope and any other error a masked 500. `APIError` passes
    /// through, so a suspended database fails the way a stopped Bun backend does.
    public mutating func serve<Operation: APIOperation>(
        _ operation: Operation.Type, _ body: @escaping BackendOperationBody
    ) {
        register(operation) { request in
            let requestId = BackendEnvelope.requestId(request.headers)
            do {
                return try BackendEnvelope.success(try await body(request), requestId: requestId)
            } catch let error as APIError {
                throw error
            } catch {
                return try BackendEnvelope.failure(error, requestId: requestId)
            }
        }
    }
}
