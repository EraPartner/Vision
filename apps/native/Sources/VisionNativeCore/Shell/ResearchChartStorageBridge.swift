import Foundation

/// Chart layouts share the web app's original metadata key. A failed read is never an empty library.
public enum ResearchChartStorageBridge {
    public static let key = "vision.research.chartBuilder.layouts.v2"
    public static let maximumWriteBytes = 250_000
    public static let script = """
        try {
            if (writing) localStorage.setItem(key, value);
            return JSON.stringify({ok: true, value: localStorage.getItem(key)});
        } catch {
            return JSON.stringify({ok: false});
        }
        """

    public static func readReply(_ reply: String) throws -> String? {
        let body = try JSONValue.parse(Data(reply.utf8))
        guard body["ok"] == .bool(true) else { throw APIError.backendUnavailable }
        if body["value"] == .null { return nil }
        guard let value = body["value"]?.stringValue else {
            throw APIError.contract(
                .init(endpoint: "chart-layout-storage", issues: ["value: Expected string or null"]))
        }
        return value
    }

    public static func writeValue(_ data: Data) throws -> String {
        guard data.count <= maximumWriteBytes, let text = String(data: data, encoding: .utf8) else {
            throw APIError.invalidRequest("chart-layout-storage")
        }
        return text
    }
}
