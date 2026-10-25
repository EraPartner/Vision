import VisionNativeCore

extension NativeShellModel {
    /// Test fixture: the shell shows `route` in place of the current history entry and reads its
    /// settings, the way the host's startup leaves it. The document is marked ready, so the
    /// native screen shows once the settings read has settled (`settingsSettled()`).
    func show(_ route: NativeRoute) {
        setNativeDocumentState(.ready)
        replace(with: route.string)
        reloadSettings()
    }
}
