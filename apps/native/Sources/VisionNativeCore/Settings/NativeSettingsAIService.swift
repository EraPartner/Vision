import Foundation

public protocol NativeSettingsAIService: Sendable {
    func settingsAIInvalidateReads(_ keys: [String]) async
    func settingsAIStatus() async throws -> AIChatOllamaStatus
    func settingsAIModels() async throws -> [AIChatOllamaModel]
    func settingsAIResearchStatus() async throws -> AIResearchStatus
    func settingsAIProviderKeys() async throws -> NativeSettingsAIProviderStatuses
    func settingsAISetProviderKey(provider: String, input: String) async throws -> NativeSettingsAIProviderStatuses
    func settingsAIClearProviderKey(provider: String) async throws
    func settingsAIDesktopStatus() async throws -> NativeSettingsAIAgentCloakStatus
    func settingsAIConfigureDesktop(enabled: Bool) async throws -> NativeSettingsAIAgentCloakStatus
}
extension NativeSettingsAIService {
    public func settingsAIInvalidateReads(_ keys: [String]) async {}
}
extension APIClient: NativeSettingsAIService {
    public func settingsAIInvalidateReads(_ keys: [String]) async { await invalidateSharedAIReads(keys: keys) }
    public func settingsAIStatus() async throws -> AIChatOllamaStatus { try await chatStatus() }
    public func settingsAIModels() async throws -> [AIChatOllamaModel] { try await chatModels() }
    public func settingsAIResearchStatus() async throws -> AIResearchStatus { try await investigationStatus() }
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
    public func settingsAIDesktopStatus() async throws -> NativeSettingsAIAgentCloakStatus {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAgentCloakDesktopStatus, NativeSettingsAIAgentCloakStatus>(
                OpenAPIOperations.GetAgentCloakDesktopStatus.self))
    }
    public func settingsAIConfigureDesktop(enabled: Bool) async throws -> NativeSettingsAIAgentCloakStatus {
        try await send(
            ResearchRequest<OpenAPIOperations.ConfigureAgentCloakDesktop, NativeSettingsAIAgentCloakStatus>(
                OpenAPIOperations.ConfigureAgentCloakDesktop.self, body: .object(["enabled": .bool(enabled)])))
    }
}
