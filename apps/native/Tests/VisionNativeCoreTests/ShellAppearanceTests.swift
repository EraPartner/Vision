import CoreGraphics
import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct ShellAppearanceTests {
    @Test func hexMatchesElectronsHslToHex() {
        #expect(LaunchAppearance.fallbackBase.hex == "#081611")
        #expect(HSLColor.parse("158 64% 52%")?.hex == "#36d399")
        #expect(HSLColor.parse("0 0% 100%")?.hex == "#ffffff")
        #expect(HSLColor.parse("red") == nil)
    }

    @Test func defaultPaletteIsTheNearBlackBrandBase() {
        let palette = LaunchAppearance.palette(theme: nil)
        #expect(!palette.isLight)
        #expect(palette.base == HSLColor(hue: 158, saturation: 45, lightness: 6))
        #expect(palette.base.hex == "#081611")
        #expect(palette.glow == HSLColor(hue: 158, saturation: 64, lightness: 52))
        #expect(palette.foreground == HSLColor(hue: 158, saturation: 24, lightness: 88))
    }

    @Test func darkThemesKeepTheirHue() {
        let palette = LaunchAppearance.palette(
            theme: SplashTheme(mode: .dark, background: "270 30% 60%", foreground: "0 0% 100%"))
        #expect(palette.base == HSLColor(hue: 270, saturation: 30, lightness: 6))
        #expect(palette.foreground == HSLColor(hue: 270, saturation: 24, lightness: 88))
    }

    @Test func lightThemesUseTheirSurfaceAndText() {
        let palette = LaunchAppearance.palette(
            theme: SplashTheme(
                mode: .light, background: "158 64% 52%", foreground: "0 0% 100%", surface: "210 40% 98%",
                text: "222 47% 11%"))
        #expect(palette.isLight)
        #expect(palette.base.hex == "#f8fafc")
        #expect(palette.foreground == HSLColor(hue: 222, saturation: 47, lightness: 11))
        // A light theme without surface and text uses the dark derivation, like Electron.
        #expect(!LaunchAppearance.palette(theme: SplashTheme(mode: .light, background: "158 64% 52%", foreground: "0 0% 100%")).isLight)
    }

    @Test func persistedThemeIsValidatedOnRead() {
        let settings: [String: JSONValue] = [
            "splashTheme": .object(["background": .string("158 64% 52%"), "foreground": .string("0 0% 100%")])
        ]
        #expect(LaunchAppearance.theme(fromSettings: settings)?.background == "158 64% 52%")
        #expect(LaunchAppearance.theme(fromSettings: ["splashTheme": .object(["background": .string("url(x)")])]) == nil)
        let theme = SplashTheme(mode: .dark, background: "1 2% 3%", foreground: "4 5% 6%")
        #expect(SplashTheme.parse(theme.jsonValue) == theme)
    }

    @Test func statusFollowsTheRuntimePhase() {
        #expect(LaunchAppearance.statusKey(for: .idle) == "splash.starting")
        #expect(LaunchAppearance.statusKey(for: .seedingDemo) == "splash.starting")
        #expect(LaunchAppearance.statusKey(for: .startingBackend) == "splash.startingServices")
        #expect(LaunchAppearance.statusKey(for: .waitingForReadiness) == "splash.waitingApp")
    }

    @Test func accentColorIsLowercaseRGBA() {
        #expect(AccentColor.hex(red: 0, green: 0.478, blue: 1, alpha: 1) == "007affff")
        #expect(AccentColor.hex(red: 1.2, green: -1, blue: 0.5, alpha: 0) == "ff008000")
    }

    @Test func dockBadgeShowsTheCountOrNothing() {
        #expect(DockBadge.label(for: 0) == nil)
        #expect(DockBadge.label(for: 3) == "3")
        #expect(DockBadge.label(for: 999) == "999")
    }

    @Test func zoomStepsByHalfALevel() {
        #expect(abs(PageZoom.zoomedIn(from: 1) - 1.0954451150103321) < 1e-9)
        #expect(abs(PageZoom.zoomedOut(from: 1) - 0.9128709291752769) < 1e-9)
        #expect(abs(PageZoom.zoomedOut(from: PageZoom.zoomedIn(from: 1)) - 1) < 1e-9)
        #expect(PageZoom.zoomedIn(from: 5) == 5)
        #expect(PageZoom.zoomedOut(from: 0.25) == 0.25)
    }
}

@Suite struct WindowFrameTests {
    @Test func savedBoundsNeedFourFiniteNumbers() {
        let settings: [String: JSONValue] = [
            "windowBounds": .object(["x": .int(10), "y": .double(20.5), "width": .int(1200), "height": .int(700)])
        ]
        #expect(WindowFrame.savedBounds(settings) == CGRect(x: 10, y: 20.5, width: 1200, height: 700))
        #expect(WindowFrame.savedBounds(["windowBounds": .object(["x": .int(1), "y": .int(2), "width": .string("3"), "height": .int(4)])]) == nil)
        #expect(WindowFrame.savedBounds(["windowBounds": .string("x")]) == nil)
        #expect(WindowFrame.savedBounds([:]) == nil)
    }

    @Test func flippingConvertsBetweenElectronAndAppKitCoordinates() {
        let electron = CGRect(x: 100, y: 50, width: 1200, height: 800)
        let appKit = WindowFrame.flipped(electron, primaryScreenHeight: 1117)
        #expect(appKit == CGRect(x: 100, y: 267, width: 1200, height: 800))
        #expect(WindowFrame.flipped(appKit, primaryScreenHeight: 1117) == electron)
    }

    @Test func clampKeepsTheWindowOnItsScreen() {
        let workArea = CGRect(x: 0, y: 0, width: 1512, height: 944)
        #expect(
            WindowFrame.clamp(CGRect(x: 2000, y: -300, width: 1600, height: 500), to: workArea)
                == CGRect(x: 0, y: 0, width: 1512, height: 600))
        #expect(
            WindowFrame.clamp(CGRect(x: 40, y: 60, width: 1280, height: 800), to: workArea)
                == CGRect(x: 40, y: 60, width: 1280, height: 800))
    }

    @Test func aWorkAreaBelowTheMinimumSizeWins() {
        let small = CGRect(x: 1512, y: 25, width: 700, height: 500)
        let clamped = WindowFrame.clamp(CGRect(x: 1600, y: 100, width: 1280, height: 800), to: small)
        #expect(clamped == small)
        #expect(small.contains(clamped))
        // Only one dimension below the minimum.
        #expect(
            WindowFrame.clamp(CGRect(x: -400, y: 900, width: 900, height: 900), to: CGRect(x: 0, y: 0, width: 1512, height: 500))
                == CGRect(x: 0, y: 0, width: 900, height: 500))
        // A window smaller than the minimum still grows to it when the work area allows.
        #expect(
            WindowFrame.clamp(CGRect(x: 10, y: 10, width: 300, height: 200), to: CGRect(x: 0, y: 0, width: 1512, height: 944))
                == CGRect(x: 10, y: 10, width: 800, height: 600))
    }

    @Test func workAreaIsTheMostOverlappingScreen() {
        let main = (frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 944))
        let side = (frame: CGRect(x: 1512, y: 0, width: 2560, height: 1440), visibleFrame: CGRect(x: 1512, y: 0, width: 2560, height: 1415))
        #expect(WindowFrame.workArea(for: CGRect(x: 1600, y: 100, width: 800, height: 600), screens: [main, side]) == side.visibleFrame)
        #expect(WindowFrame.workArea(for: CGRect(x: -5000, y: 0, width: 800, height: 600), screens: [main, side]) == main.visibleFrame)
        #expect(WindowFrame.workArea(for: .zero, screens: []) == nil)
    }

    @Test func initialFrameRestoresAndClampsTheSavedBounds() {
        let screens = [(frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 944))]
        let settings: [String: JSONValue] = [
            "windowBounds": .object(["x": .int(100), "y": .int(38), "width": .int(1280), "height": .int(800)])
        ]
        #expect(
            WindowFrame.initialFrame(settings: settings, primaryScreenHeight: 982, screens: screens)
                == CGRect(x: 100, y: 144, width: 1280, height: 800))
        #expect(WindowFrame.initialFrame(settings: [:], primaryScreenHeight: 982, screens: screens) == nil)
    }

    @Test func boundsAreStoredAsIntegers() {
        #expect(
            WindowFrame.json(CGRect(x: 10.4, y: 20.6, width: 1280, height: 800))
                == .object(["x": .int(10), "y": .int(21), "width": .int(1280), "height": .int(800)]))
    }
}

@Suite struct CSVHandoffTests {
    @Test func onlyRegularCSVFilesUpTo25MiB() {
        #expect(CSVHandoff.accepts(path: "/Users/demo/Bank.CSV", isRegularFile: true, size: 1024))
        #expect(!CSVHandoff.accepts(path: "/Users/demo/bank.xlsx", isRegularFile: true, size: 1024))
        #expect(!CSVHandoff.accepts(path: "/Users/demo/folder.csv", isRegularFile: false, size: 0))
        #expect(!CSVHandoff.accepts(path: "/Users/demo/huge.csv", isRegularFile: true, size: CSVHandoff.maximumBytes + 1))
        #expect(!CSVHandoff.accepts(path: "/Users/demo/unknown.csv", isRegularFile: true, size: nil))
    }

    @Test func payloadCarriesNameAndText() {
        #expect(
            CSVHandoff.payload(name: "bank.csv", data: Data("a,b\n1,2\n".utf8))
                == .object(["name": .string("bank.csv"), "content": .string("a,b\n1,2\n")]))
    }
}

@Suite struct PageZoomPersistenceTests {
    @Test func storedFactorsSnapToAZoomStepAndInvalidValuesAreActualSize() {
        #expect(PageZoom.persisted(.double(1.2)) == PageZoom.factor(forLevel: 1))
        #expect(abs(PageZoom.persisted(.double(1.19)) - 1.2) < 0.0001)
        #expect(PageZoom.persisted(.int(1)) == 1)
        #expect(PageZoom.persisted(.double(50)) == PageZoom.maximumFactor)
        for invalid: JSONValue? in [nil, .null, .string("2"), .double(0), .double(-1), .double(.nan), .bool(true)] {
            #expect(PageZoom.persisted(invalid) == 1)
        }
    }
}
