import CoreText
import SwiftUI

/// The web's display face (`--font-display`: Fraunces, then Iowan Old Style) for titles. The
/// bundled TrueType is registered for this process on first use; without it the title falls
/// back to Iowan Old Style, as the web stack does.
enum VisionFonts {
    static let displayName = "Fraunces-SemiBold"

    private static let registered: Bool = {
        guard let url = Bundle.module.url(forResource: "Fraunces-SemiBold", withExtension: "ttf", subdirectory: "Fonts")
        else { return false }
        return CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            || CTFontCreateWithName(displayName as CFString, 12, nil).postScriptName == displayName
    }()

    /// `type-large-title`, `type-title-1/2/3`: Fraunces 600 at the web size, scaled with
    /// Dynamic Type relative to `style`.
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        registered
            ? Font.custom(displayName, size: size, relativeTo: style)
            : Font.custom("Iowan Old Style", size: size, relativeTo: style).weight(.semibold)
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
    /// `type-title-2`: `CardTitle`'s default.
    static var visionCardTitle: Font { VisionFonts.display(20, relativeTo: .title2) }
}
