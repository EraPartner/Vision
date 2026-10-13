import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Source macOS accent semantic tokens")
struct NativeSystemAccentThemeTests {
    @Test func noOverridePreservesAllCanonicalPrimaryAndSidebarTokens() {
        for variant in ThemeVariant.allCases {
            for appearance in ThemeAppearance.allCases {
                let selection = ThemeSelection(variant: variant, appearance: appearance)
                #expect(selection.primary == selection.palette.primary)
                #expect(selection.primaryForeground == selection.palette.primaryForeground)
                #expect(selection.ring == selection.palette.ring)
                #expect(selection.sidebarPrimary == selection.palette.sidebarPrimary)
                #expect(selection.sidebarPrimaryForeground == selection.palette.sidebarPrimaryForeground)
                #expect(selection.sidebarRing == selection.palette.sidebarRing)
            }
        }
    }
    @Test func enabledAccentOverridesSixSemanticTokensAndLeavesPaletteAndFinancialSkinAlone() throws {
        let accent = try #require(AccentColor.themeTokens(hex: "ffcc00ff"))
        for variant in ThemeVariant.allCases {
            for appearance in ThemeAppearance.allCases {
                let canonical = ThemeSelection(variant: variant, appearance: appearance)
                var selection = canonical
                selection.systemAccentColor = accent.color
                selection.systemAccentForegroundColor = accent.foreground
                #expect(selection.primary == accent.color && selection.ring == accent.color)
                #expect(selection.sidebarPrimary == accent.color && selection.sidebarRing == accent.color)
                #expect(
                    selection.primaryForeground == accent.foreground
                        && selection.sidebarPrimaryForeground == accent.foreground)
                let glass = ShellGlass(selection: selection)
                #expect(glass.selection == accent.color && glass.icon == accent.color)
                #expect(
                    glass.foreground == canonical.palette.sidebarForeground
                        && glass.detailTint == canonical.palette.background)
                #expect(selection.palette == canonical.palette)
                #expect(selection.palette.accent == canonical.palette.accent)
                #expect(selection.gain == canonical.gain && selection.loss == canonical.loss)
                selection.colorblindGainLoss = true
                #expect(
                    selection.gain == canonical.palette.colorblindGain
                        && selection.loss == canonical.palette.colorblindLoss)
                selection.systemAccentColor = nil
                #expect(
                    selection.primary == canonical.primary && selection.primaryForeground == canonical.primaryForeground
                )
            }
        }
    }
    @Test func rgbAndAlphaParsingMatchesSourceRoundedHsl() throws {
        let white = try #require(AccentColor.themeTokens(hex: "ffffff"))
        #expect(white.color == .init(hue: 0, saturation: 0, lightness: 100))
        #expect(white.foreground == .init(hue: 224, saturation: 47, lightness: 10))
        let black = try #require(AccentColor.themeTokens(hex: "#00000000"))
        #expect(black.color == .init(hue: 0, saturation: 0, lightness: 0))
        #expect(black.foreground == .init(hue: 0, saturation: 0, lightness: 100))
        let red = try #require(AccentColor.themeTokens(hex: "FF0000FF"))
        #expect(red.color == .init(hue: 0, saturation: 100, lightness: 50))
        #expect(red.foreground == .init(hue: 224, saturation: 47, lightness: 10))
        let blue = try #require(AccentColor.themeTokens(hex: "0000ff"))
        #expect(blue.color == .init(hue: 240, saturation: 100, lightness: 50))
        #expect(blue.foreground == .init(hue: 0, saturation: 0, lightness: 100))
        #expect(AccentColor.themeTokens(hex: "#FFCC0000") == AccentColor.themeTokens(hex: "ffcc00ff"))
    }
    @Test func strictHexParsingUsesExactSourceWhitespaceAndRejectsMalformedInput() {
        #expect(AccentColor.themeTokens(hex: " \u{FEFF}#abcdef80\n") != nil)
        for invalid in [
            "fff", "#1234567", "##123456", "1234567890", "12345g", "123456\nnoise", "\u{0085}123456", "0x123456",
        ] {
            #expect(AccentColor.themeTokens(hex: invalid) == nil)
        }
    }
    @Test func foregroundUsesOriginalRgbRatherThanRoundedHslWhenContrastBoundaryDiffers() throws {
        // This RGB lies near the white/black contrast boundary; rounded HSL would choose the other foreground.
        let original = try #require(AccentColor.themeTokens(hex: "006cff"))
        #expect(original.foreground == .init(hue: 224, saturation: 47, lightness: 10))
        #expect(AccentColor.foreground(for: original.color) == .init(hue: 0, saturation: 0, lightness: 100))
        let selection = ThemeSelection(
            appearance: .dark, systemAccentColor: original.color, systemAccentForegroundColor: original.foreground)
        #expect(selection.primaryForeground == original.foreground)
    }
    @Test func accentChangesParticipateInThemeEqualityWithoutChangingVariantIdentity() throws {
        let blue = try #require(AccentColor.themeTokens(hex: "007aff"))
        let orange = try #require(AccentColor.themeTokens(hex: "ff9500"))
        let first = ThemeSelection(
            variant: .nord, appearance: .dark, systemAccentColor: blue.color,
            systemAccentForegroundColor: blue.foreground)
        let second = ThemeSelection(
            variant: .nord, appearance: .dark, systemAccentColor: orange.color,
            systemAccentForegroundColor: orange.foreground)
        #expect(first != second && first.variant == second.variant && first.palette == second.palette)
    }
}
