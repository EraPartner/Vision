import CoreText
import SwiftUI
import VisionNativeCore

/// The web's faces (`--font-display`: Fraunces, then Iowan Old Style; `--font-body`: Inter, then
/// the system font). The bundled TrueType files (the web's latin subsets, OFL-1.1) are
/// registered for this process on first use; without one, text falls back to the web stack's
/// next face.
enum VisionFonts {
    static let displayName = "Fraunces-SemiBold"

    /// Every bundled face in `Resources/Fonts`: Fraunces 400/600/700 and Inter 400, 400 italic,
    /// 500, 600 and 700, the faces `styles/fonts.css` ships.
    static let bundledFaces = [
        "Fraunces-Regular", "Fraunces-SemiBold", "Fraunces-Bold",
        "Inter-Regular", "Inter-Italic", "Inter-Medium", "Inter-SemiBold", "Inter-Bold",
    ]

    /// The bundled faces that are usable by PostScript name, after registering the files once.
    private static let registered: Set<String> = {
        var available = Set<String>()
        for name in bundledFaces {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
            else { continue }
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
                || CTFontCreateWithName(name as CFString, 12, nil).postScriptName == name
            {
                available.insert(name)
            }
        }
        return available
    }()

    /// `type-large-title`, `type-title-1/2/3`: Fraunces 600 at the web size, scaled with
    /// Dynamic Type relative to `style`.
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        registered.contains(displayName)
            ? Font.custom(displayName, size: size, relativeTo: style)
            : Font.custom("Iowan Old Style", size: size, relativeTo: style).weight(.semibold)
    }

    /// The Inter face for a CSS weight (400, 500, 600 and 700 are bundled; others round to them).
    static func bodyFaceName(weight: Int) -> String {
        switch weight {
        case ..<450: return "Inter-Regular"
        case ..<550: return "Inter-Medium"
        case ..<650: return "Inter-SemiBold"
        default: return "Inter-Bold"
        }
    }

    /// `type-headline`, `-body`, `-callout`, `-footnote`, `-caption`: Inter at the web size and
    /// weight, scaled with Dynamic Type relative to `style`. Falls back to the system font.
    static func body(_ size: CGFloat, weight: Int = 400, relativeTo style: Font.TextStyle) -> Font {
        let name = bodyFaceName(weight: weight)
        return registered.contains(name)
            ? Font.custom(name, size: size, relativeTo: style)
            : Font.system(size: size, weight: systemWeight(weight))
    }

    /// A role of the web's type ramp (`DesignTokens.Typography`). Tracking and line height are not part
    /// of a `Font`: apply `style.tracking * style.size` with `.tracking(_:)` and the line height
    /// with `.lineSpacing(_:)`.
    static func font(_ style: TypeStyle, relativeTo textStyle: Font.TextStyle) -> Font {
        switch style.face {
        case .display: return display(CGFloat(style.size), relativeTo: textStyle)
        case .body: return body(CGFloat(style.size), weight: style.weight, relativeTo: textStyle)
        }
    }

    private static func systemWeight(_ weight: Int) -> Font.Weight {
        switch weight {
        case ..<450: return .regular
        case ..<550: return .medium
        case ..<650: return .semibold
        default: return .bold
        }
    }
}

private extension CTFont {
    var postScriptName: String { CTFontCopyPostScriptName(self) as String }
}

extension Font {
    /// `type-large-title`: page titles.
    static var visionLargeTitle: Font { VisionFonts.display(32, relativeTo: .largeTitle) }
    /// `font-display type-headline`: the topbar's scrolled page title.
    static var visionDisplayHeadline: Font { VisionFonts.display(14, relativeTo: .headline) }
    /// `type-title-1`: stat-card values and the onboarding welcome.
    static var visionTitle1: Font { VisionFonts.display(24, relativeTo: .title) }
    /// `type-title-3`: `CardTitle variant="sm"` and `ChartCard` titles.
    static var visionTitle3: Font { VisionFonts.display(17, relativeTo: .title3) }
    /// `type-title-2`: `CardTitle`'s default.
    static var visionCardTitle: Font { VisionFonts.display(20, relativeTo: .title2) }
}
