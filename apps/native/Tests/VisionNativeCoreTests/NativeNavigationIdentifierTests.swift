import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native-only Number coercion for route identifiers")
struct NativeNavigationIdentifierTests {
    @Test func sourceNumberAndBackendBoundsMatchTheFortyNineCaseOracle() {
        // Installed React Router 8.3/Number oracle, then the actual backend
        // validateId accept set applied to the API's String(Number(parameter)).
        // Empty text here means Number("") = 0; an empty route segment never matches.
        let cases: [(parameter: String, finite: Bool, account: Int?, batch: Int?)] = [
            ("1", true, 1, 1),
            ("01", true, 1, 1),
            ("0001", true, 1, 1),
            ("1e2", true, 100, 100),
            ("1E+2", true, 100, 100),
            ("+1", true, 1, 1),
            ("1.", true, 1, 1),
            ("1.0", true, 1, 1),
            (".1e1", true, 1, 1),
            ("0x10", true, 16, 16),
            ("0X10", true, 16, 16),
            ("0b11", true, 3, 3),
            ("0o17", true, 15, 15),
            ("+0x10", false, nil, nil),
            ("-0x10", false, nil, nil),
            (" 1 ", true, 1, 1),
            ("\u{FEFF}1\u{FEFF}", true, 1, 1),
            ("\u{00A0}1\u{2028}", true, 1, 1),
            ("\u{0009}1\u{000A}", true, 1, 1),
            ("\u{0085}1", false, nil, nil),
            ("\u{200B}1", false, nil, nil),
            ("1_000", false, nil, nil),
            ("1,000", false, nil, nil),
            ("12abc", false, nil, nil),
            ("1e", false, nil, nil),
            ("1.5", true, nil, nil),
            ("-1", true, nil, nil),
            ("0", true, nil, nil),
            ("-0", true, nil, nil),
            ("", true, nil, nil),
            (" ", true, nil, nil),
            ("Infinity", false, nil, nil),
            ("+Infinity", false, nil, nil),
            ("-Infinity", false, nil, nil),
            ("inf", false, nil, nil),
            ("NaN", false, nil, nil),
            ("1e309", false, nil, nil),
            ("1e-324", true, nil, nil),
            ("2147483647", true, 2147483647, 2147483647),
            ("2147483648", true, nil, 2147483648),
            ("9007199254740990", true, nil, 9007199254740990),
            ("9007199254740990.5", true, nil, 9007199254740990),
            ("9007199254740991", true, nil, 9007199254740991),
            ("9007199254740991.1", true, nil, 9007199254740991),
            ("9007199254740992", true, nil, nil),
            ("9007199254740993", true, nil, nil),
            ("9223372036854775807", true, nil, nil),
            ("1/2", false, nil, nil),
            ("%31", false, nil, nil),
        ]
        #expect(cases.count == 49)
        for row in cases {
            let parsed = NativeNavigationIdentifier(row.parameter)
            #expect(parsed.category == (row.finite ? .finite : .nonFinite), "Parameter: \(String(reflecting: row.parameter))")
            #expect(parsed.positiveInteger(upTo: Int(Int32.max)) == row.account)
            #expect(parsed.positiveInteger(upTo: 9_007_199_254_740_991) == row.batch)
        }
    }

    @Test func binaryOctalAndHexadecimalConvertOnceAtTheBinary64RoundingBoundary() {
        let maximum = 9_007_199_254_740_991
        for parameter in [
            "0x1fffffffffffff", "0b" + String(repeating: "1", count: 53), "0o377777777777777777",
        ] {
            #expect(NativeNavigationIdentifier(parameter).positiveInteger(upTo: maximum) == maximum)
        }
        for parameter in [
            "0x20000000000001", "0b1" + String(repeating: "0", count: 52) + "1", "0o400000000000000001",
        ] {
            let parsed = NativeNavigationIdentifier(parameter)
            #expect(parsed.category == .finite)
            #expect(parsed.positiveInteger(upTo: maximum) == nil)
            #expect(parsed.positiveInteger(upTo: 9_007_199_254_740_992) == 9_007_199_254_740_992)
        }
    }

    @Test func unsignedRadicesRejectSwiftOnlySyntaxAndPreserveLeadingZeros() {
        for parameter in ["+0x1", "-0b1", "+0o1", "0x1p2", "0x1.0", "0b2", "0o8", "0x", "nan", "inf"] {
            #expect(NativeNavigationIdentifier(parameter).category == .nonFinite)
        }
        for prefix in ["0x", "0b", "0o"] {
            #expect(NativeNavigationIdentifier(prefix + String(repeating: "0", count: 1000) + "1")
                .positiveInteger(upTo: 1) == 1)
        }
    }

    @Test func hugeRadicesKeepFiniteAndOverflowCategoriesDistinct() {
        #expect(NativeNavigationIdentifier("0b1" + String(repeating: "0", count: 1023)).category == .finite)
        #expect(NativeNavigationIdentifier("0b1" + String(repeating: "0", count: 1024)).category == .nonFinite)
        #expect(NativeNavigationIdentifier("0o1" + String(repeating: "0", count: 341)).category == .finite)
        #expect(NativeNavigationIdentifier("0o1" + String(repeating: "0", count: 342)).category == .nonFinite)
    }

    @Test func integerConversionAndCallerBoundCannotRoundUpToAnotherIdentifier() {
        #expect(NativeNavigationIdentifier("16").positiveInteger(upTo: 15) == nil)
        #expect(NativeNavigationIdentifier("16").positiveInteger(upTo: 16) == 16)
        #expect(NativeNavigationIdentifier("1").positiveInteger(upTo: 0) == nil)
        #expect(NativeNavigationIdentifier("1").positiveInteger(upTo: -1) == nil)
        #expect(NativeNavigationIdentifier("1.5").positiveInteger(upTo: 100) == nil)
        #expect(NativeNavigationIdentifier("9223372036854775807").positiveInteger(upTo: Int.max) == nil)
        #expect(NativeNavigationIdentifier("9007199254740996").positiveInteger(upTo: 9_007_199_254_740_995) == nil)
    }
}
