import Foundation

public protocol NativeSettingsAIService: Sendable {
    func settingsAIInvalidateReads(_ keys: [String]) async
    func settingsAIStatus() async throws -> AIChatOllamaStatus
    func settingsAIModels() async throws -> [AIChatOllamaModel]
    func settingsAIProviderKeys() async throws -> NativeSettingsAIProviderStatuses
    func settingsAISetProviderKey(provider: String, input: String) async throws -> NativeSettingsAIProviderStatuses
    func settingsAIClearProviderKey(provider: String) async throws
}
extension NativeSettingsAIService {
    public func settingsAIInvalidateReads(_ keys: [String]) async {}
}
extension APIClient: NativeSettingsAIService {
    public func settingsAIInvalidateReads(_ keys: [String]) async { await invalidateSharedAIReads(keys: keys) }
    public func settingsAIStatus() async throws -> AIChatOllamaStatus { try await chatStatus() }
    public func settingsAIModels() async throws -> [AIChatOllamaModel] { try await chatModels() }
    public func settingsAIProviderKeys() async throws -> NativeSettingsAIProviderStatuses {
        try await send(
            ResearchRequest<OpenAPIOperations.ResearchListProviderKeys, NativeSettingsAIProviderStatuses>(
                OpenAPIOperations.ResearchListProviderKeys.self))
    }
    public func settingsAISetProviderKey(provider: String, input: String) async throws
        -> NativeSettingsAIProviderStatuses
    {
        try await send(
            ResearchRequest<OpenAPIOperations.ResearchSetProviderKey, NativeSettingsAIProviderStatuses>(
                OpenAPIOperations.ResearchSetProviderKey.self, parameters: ["provider": provider],
                body: .object(["api_key": .string(input)])))
    }
    public func settingsAIClearProviderKey(provider: String) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.ResearchClearProviderKey, APIEmpty>(
                OpenAPIOperations.ResearchClearProviderKey.self, parameters: ["provider": provider]))
    }
}
