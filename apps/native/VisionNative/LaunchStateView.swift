import Observation
import SwiftUI
import VisionNativeCore

/// What the window shows: a check in progress, the web shell, or the reason the
/// backend is unavailable.
enum ShellState: Equatable, Sendable {
    case checking
    case ready(URL, NativeShellBackendSource)
    case unavailable(String)
}

enum ShellResolver {
    /// Debug builds honour a loopback `VISION_NATIVE_BACKEND_URL` and skip supervision;
    /// otherwise Vision Native starts its own PostgreSQL and backend and waits until the
    /// backend is ready.
    static func resolve() async -> ShellState {
        switch BackendLocator.developerOverride(
            environment: ProcessInfo.processInfo.environment, allowOverride: AppRuntime.isDebugBuild)
        {
        case .use(let url):
            return await checkOverride(url)
        case .ignored(let reason):
            AppRuntime.logger.warning("\(reason, privacy: .public)")
        case .none:
            break
        }
        do {
            let url = try await AppRuntime.supervisor.launch()
            return .ready(url, .supervised(runtimeIdentifier: AppRuntime.variant.runtimeId))
        } catch {
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return .unavailable(reason)
        }
    }

    /// The developer override must answer `GET /health` with 200.
    private static func checkOverride(_ baseURL: URL) async -> ShellState {
        let healthURL = BackendHealth.healthURL(baseURL: baseURL)
        do {
            let status = try await BackendHealth.status(baseURL: baseURL)
            guard status == 200 else {
                return .unavailable("\(healthURL.absoluteString) answered HTTP \(status).")
            }
            return .ready(baseURL, .developerOverride)
        } catch {
            return .unavailable(
                "The backend is not running at \(healthURL.absoluteString): \(error.localizedDescription)"
            )
        }
    }
}

/// The launch screen's state: the Electron splash while the runtime starts, and its
/// error page (`assets/error.html`) when it cannot.
@MainActor
@Observable
final class LaunchModel {
    let appName: String
    var state: ShellState = .checking
    var statusKey = "splash.starting"
    var strings: ShellStrings
    var palette: LaunchPalette
    @ObservationIgnored var onRetry: @MainActor () -> Void = {}
    @ObservationIgnored var onOpenLogs: @MainActor () -> Void = {}

    init(appName: String, strings: ShellStrings, palette: LaunchPalette) {
        self.appName = appName
        self.strings = strings
        self.palette = palette
    }
}

extension Color {
    static func hsl(_ color: HSLColor, opacity: Double = 1) -> Color {
        let rgb = color.rgb
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: opacity)
    }
}

/// The Vision mark from the splash and the app icon (viewBox 262 296 500 500).
struct VisionMark: Shape {
    nonisolated func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 500
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + (x - 262) * scale, y: rect.minY + (y - 296) * scale)
        }
        var path = Path()
        path.move(to: point(268, 300))
        path.addLine(to: point(512, 792))
        path.addLine(to: point(756, 300))
        path.addLine(to: point(656, 300))
        path.addLine(to: point(512, 596))
        path.addLine(to: point(368, 300))
        path.closeSubpath()
        let center = point(512, 444)
        let radius = 40 * scale
        path.addEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        return path
    }
}

/// The launch state: the splash palette (`deriveSplashPalette`), the mark, a spinner and
/// the localized status, or the error with Open Logs and Retry.
struct LaunchStateView: View {
    let model: LaunchModel

    private var foreground: Color { .hsl(model.palette.foreground) }

    var body: some View {
        ZStack {
            Color.hsl(model.palette.base)
                .overlay(
                    RadialGradient(
                        colors: [.hsl(model.palette.glow, opacity: 0.16), .clear],
                        center: UnitPoint(x: 0.5, y: 0.38), startRadius: 0, endRadius: 560)
                )
                .ignoresSafeArea()
            content
                .foregroundStyle(foreground.opacity(0.82))
                .padding(32)
                .frame(maxWidth: 560)
        }
        .environment(\.colorScheme, model.palette.isLight ? .light : .dark)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .checking, .ready:
            VStack(spacing: 14) {
                VisionMark().fill(foreground).frame(width: 44, height: 44)
                ProgressView().controlSize(.small)
                Text(model.appName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(foreground)
                Text(model.strings.t(model.statusKey))
                    .font(.system(size: 13))
                    .monospacedDigit()
            }
        case .unavailable(let reason):
            VStack(spacing: 14) {
                VisionMark().fill(foreground).frame(width: 44, height: 44)
                Text(model.strings.t("app.errorPageTitle", fallback: "Vision couldn't start"))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(foreground)
                Text(reason)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                HStack(spacing: 12) {
                    Button(model.strings.t("app.errorPageOpenLogs", fallback: "Open logs")) { model.onOpenLogs() }
                    Button(model.strings.t("app.errorPageRetry", fallback: "Try again")) { model.onRetry() }
                        .keyboardShortcut(.defaultAction)
                }
                .padding(.top, 4)
            }
        }
    }
}
