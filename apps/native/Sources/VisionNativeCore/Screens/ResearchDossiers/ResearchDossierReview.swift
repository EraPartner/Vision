import Foundation

public enum ResearchDossierLinesField: Sendable { case assumptions, openQuestions }
public struct ResearchDossierReview: Identifiable, Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case discardForNew
        case discardForSelection(id: ResearchDossierID)
        case delete(id: ResearchDossierID)
        case restore(id: ResearchDossierID, version: Int, expectedVersion: Int)
        case reload(id: ResearchDossierID)
    }
    public let id: UUID
    public let action: Action
    let selection: UUID
    init(action: Action, selection: UUID) {
        id = UUID()
        self.action = action
        self.selection = selection
    }
    public var titleKey: String {
        switch action {
        case .discardForNew, .discardForSelection: "dossiers.discardChangesTitle"
        case .delete: "dossiers.deleteTitle"
        case .restore: "dossiers.restoreTitle"
        case .reload: "dossiers.reloadTitle"
        }
    }
    public var descriptionKey: String {
        switch action {
        case .discardForNew, .discardForSelection: "dossiers.discardChangesConfirm"
        case .delete: "dossiers.deleteConfirm"
        case .restore: "dossiers.restoreConfirm"
        case .reload: "dossiers.reloadConfirm"
        }
    }
    public var confirmKey: String {
        switch action {
        case .discardForNew, .discardForSelection: "dossiers.discardChanges"
        case .delete: "dossiers.delete"
        case .restore: "dossiers.restore"
        case .reload: "dossiers.reloadLatest"
        }
    }
    public var destructive: Bool {
        if case .restore = action { return false }
        return true
    }
}
