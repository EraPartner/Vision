import Foundation

/// The fixed external links (`REPOSITORY_URL`, `DOCUMENTATION_URL` in packaging/electron/main.ts).
public enum ShellLinks {
    public static let repository = "https://github.com/EraPartner/Vision"
    public static let documentation = "https://github.com/EraPartner/Vision/tree/main/docs"
    /// `TRUSTED_EXTERNAL_URLS`: the only URLs the shell hands to the default browser, compared
    /// as exact strings like `openTrustedExternalUrl`.
    public static let trustedExternal: Set<String> = [repository, documentation]

    public static func trustedExternalURL(_ url: URL?) -> URL? {
        guard let url, trustedExternal.contains(url.absoluteString) else { return nil }
        return url
    }
}
