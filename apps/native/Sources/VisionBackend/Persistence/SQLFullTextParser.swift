import Foundation

/// PostgreSQL full-text search for SQLite (ADR-263), a port of fts.ts, replacing
///
///     to_tsvector('simple', doc) @@ websearch_to_tsquery('simple', q)
///     ts_rank_cd(to_tsvector('simple', doc), websearch_to_tsquery('simple', q))
///
/// with the same tokens, lexemes, positions, match results and ranks: the default parser's
/// state machine (wparser_def.c, C locale: every non-ASCII character is a letter), the
/// `simple` configuration, websearch_to_tsquery (tsquery.c), `@@` and ts_rank_cd with
/// normalization 0 (tsvector_op.c, tsrank.c).
public enum SQLFullText {
    /// Token types (wparser_def.c), numbered as ts_token_type('default').
    public static let tokenTypes = [
        "", "asciiword", "word", "numword", "email", "url", "host", "sfloat", "version", "hword_numpart",
        "hword_part", "hword_asciipart", "blank", "tag", "protocol", "numhword", "asciihword", "hword", "url_path",
        "file", "float", "int", "uint", "entity",
    ]

    static let host = 6
    static let urlPath = 18

    /// Token types the `simple` configuration maps to the `simple` dictionary.
    static let indexed: Set<Int> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22]

    enum F {
        static let next = 0
        static let bingo = 1
        static let pop = 2
        static let push = 4
        static let rerun = 8
        static let clear = 16
        static let merge = 32
        static let clrall = 64
    }

    enum State: Sendable {
        case base
        case inNumWord
        case inAsciiWord
        case inWord
        case inUnsignedInt
        case inSignedIntFirst
        case inSignedInt
        case inSpace
        case inUDecimalFirst
        case inUDecimal
        case inDecimalFirst
        case inDecimal
        case inVerVersion
        case inSVerVersion
        case inVersionFirst
        case inVersion
        case inMantissaFirst
        case inMantissaSign
        case inMantissa
        case inXMLEntityFirst
        case inXMLEntity
        case inXMLEntityNumFirst
        case inXMLEntityHexNumFirst
        case inXMLEntityNum
        case inXMLEntityHexNum
        case inXMLEntityEnd
        case inTagFirst
        case inXMLBegin
        case inTagCloseFirst
        case inTagName
        case inTagBeginEnd
        case inTag
        case inTagEscapeK
        case inTagEscapeKK
        case inTagBackSleshed
        case inTagEnd
        case inCommentFirst
        case inCommentLast
        case inComment
        case inCloseCommentFirst
        case inCloseCommentLast
        case inCommentEnd
        case inHostFirstDomain
        case inHostDomainSecond
        case inHostDomain
        case inPortFirst
        case inPort
        case inHostFirstAN
        case inHost
        case inEmail
        case inFileFirst
        case inFileTwiddle
        case inPathFirst
        case inPathFirstFirst
        case inPathSecond
        case inFile
        case inFileNext
        case inURLPathFirst
        case inURLPathStart
        case inURLPath
        case inFURL
        case inProtocolFirst
        case inProtocolSecond
        case inProtocolEnd
        case inHyphenAsciiWordFirst
        case inHyphenAsciiWord
        case inHyphenWordFirst
        case inHyphenWord
        case inHyphenNumWordFirst
        case inHyphenNumWord
        case inHyphenDigitLookahead
        case inParseHyphen
        case inParseHyphenHyphen
        case inHyphenWordPart
        case inHyphenAsciiWordPart
        case inHyphenNumWordPart
        case inHyphenUnsignedInt
    }

    enum Test: Sendable {
        case always, eof, alnum, alpha, digit, xdigit, space, notAlnum, ascLet, special, ignore, stopHost, urlChar
        case host, urlPath
        case eq(Unicode.Scalar)
    }

    enum Special: Sendable {
        case tags, furl, hyphen, verVersion
    }

    struct A: Sendable {
        let test: Test
        let flags: Int
        let to: State?
        let type: Int
        let special: Special?

        init(_ test: Test, _ flags: Int, _ to: State?, _ type: Int, _ special: Special? = nil) {
            self.test = test
            self.flags = flags
            self.to = to
            self.type = type
            self.special = special
        }
    }

    static let actions: [State: [A]] = [
        .base: [
            A(.eof, F.next, nil, 0),
            A(.eq("<"), F.push, .inTagFirst, 0),
            A(.ignore, F.next, .inSpace, 0),
            A(.ascLet, F.next, .inAsciiWord, 0),
            A(.alpha, F.next, .inWord, 0),
            A(.digit, F.next, .inUnsignedInt, 0),
            A(.eq("-"), F.push, .inSignedIntFirst, 0),
            A(.eq("+"), F.push, .inSignedIntFirst, 0),
            A(.eq("&"), F.push, .inXMLEntityFirst, 0),
            A(.eq("~"), F.push, .inFileTwiddle, 0),
            A(.eq("/"), F.push, .inFileFirst, 0),
            A(.eq("."), F.push, .inPathFirstFirst, 0),
            A(.always, F.next, .inSpace, 0),
        ],
        .inNumWord: [
            A(.eof, F.bingo, .base, 3),
            A(.alnum, F.next, .inNumWord, 0),
            A(.special, F.next, .inNumWord, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.eq("/"), F.push, .inFileFirst, 0),
            A(.eq("."), F.push, .inFileNext, 0),
            A(.eq("-"), F.push, .inHyphenNumWordFirst, 0),
            A(.always, F.bingo, .base, 3),
        ],
        .inAsciiWord: [
            A(.eof, F.bingo, .base, 1),
            A(.ascLet, F.next, nil, 0),
            A(.eq("."), F.push, .inHostFirstDomain, 0),
            A(.eq("."), F.push, .inFileNext, 0),
            A(.eq("-"), F.push, .inHostFirstAN, 0),
            A(.eq("-"), F.push, .inHyphenAsciiWordFirst, 0),
            A(.eq("_"), F.push, .inHostFirstAN, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.eq(":"), F.push, .inProtocolFirst, 0),
            A(.eq("/"), F.push, .inFileFirst, 0),
            A(.digit, F.push, .inHost, 0),
            A(.digit, F.next, .inNumWord, 0),
            A(.alpha, F.next, .inWord, 0),
            A(.special, F.next, .inWord, 0),
            A(.always, F.bingo, .base, 1),
        ],
        .inWord: [
            A(.eof, F.bingo, .base, 2),
            A(.alpha, F.next, nil, 0),
            A(.special, F.next, nil, 0),
            A(.digit, F.next, .inNumWord, 0),
            A(.eq("-"), F.push, .inHyphenWordFirst, 0),
            A(.always, F.bingo, .base, 2),
        ],
        .inUnsignedInt: [
            A(.eof, F.bingo, .base, 22),
            A(.digit, F.next, nil, 0),
            A(.eq("."), F.push, .inHostFirstDomain, 0),
            A(.eq("."), F.push, .inUDecimalFirst, 0),
            A(.eq("e"), F.push, .inMantissaFirst, 0),
            A(.eq("E"), F.push, .inMantissaFirst, 0),
            A(.eq("-"), F.push, .inHostFirstAN, 0),
            A(.eq("_"), F.push, .inHostFirstAN, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.ascLet, F.push, .inHost, 0),
            A(.alpha, F.next, .inNumWord, 0),
            A(.special, F.next, .inNumWord, 0),
            A(.eq("/"), F.push, .inFileFirst, 0),
            A(.always, F.bingo, .base, 22),
        ],
        .inSignedIntFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next | F.clear, .inSignedInt, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inSignedInt: [
            A(.eof, F.bingo, .base, 21),
            A(.digit, F.next, nil, 0),
            A(.eq("."), F.push, .inDecimalFirst, 0),
            A(.eq("e"), F.push, .inMantissaFirst, 0),
            A(.eq("E"), F.push, .inMantissaFirst, 0),
            A(.always, F.bingo, .base, 21),
        ],
        .inSpace: [
            A(.eof, F.bingo, .base, 12),
            A(.eq("<"), F.bingo, .base, 12),
            A(.ignore, F.next, nil, 0),
            A(.eq("-"), F.bingo, .base, 12),
            A(.eq("+"), F.bingo, .base, 12),
            A(.eq("&"), F.bingo, .base, 12),
            A(.eq("/"), F.bingo, .base, 12),
            A(.notAlnum, F.next, .inSpace, 0),
            A(.always, F.bingo, .base, 12),
        ],
        .inUDecimalFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.clear, .inUDecimal, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inUDecimal: [
            A(.eof, F.bingo, .base, 20),
            A(.digit, F.next, .inUDecimal, 0),
            A(.eq("."), F.push, .inVersionFirst, 0),
            A(.eq("e"), F.push, .inMantissaFirst, 0),
            A(.eq("E"), F.push, .inMantissaFirst, 0),
            A(.always, F.bingo, .base, 20),
        ],
        .inDecimalFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.clear, .inDecimal, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inDecimal: [
            A(.eof, F.bingo, .base, 20),
            A(.digit, F.next, .inDecimal, 0),
            A(.eq("."), F.push, .inVerVersion, 0),
            A(.eq("e"), F.push, .inMantissaFirst, 0),
            A(.eq("E"), F.push, .inMantissaFirst, 0),
            A(.always, F.bingo, .base, 20),
        ],
        .inVerVersion: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.rerun, .inSVerVersion, 0, .verVersion),
            A(.always, F.pop, nil, 0),
        ],
        .inSVerVersion: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.bingo | F.clrall, .inUnsignedInt, 12),
            A(.always, F.next, nil, 0),
        ],
        .inVersionFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.clear, .inVersion, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inVersion: [
            A(.eof, F.bingo, .base, 8),
            A(.digit, F.next, .inVersion, 0),
            A(.eq("."), F.push, .inVersionFirst, 0),
            A(.always, F.bingo, .base, 8),
        ],
        .inMantissaFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.clear, .inMantissa, 0),
            A(.eq("+"), F.next, .inMantissaSign, 0),
            A(.eq("-"), F.next, .inMantissaSign, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inMantissaSign: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.clear, .inMantissa, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inMantissa: [
            A(.eof, F.bingo, .base, 7),
            A(.digit, F.next, .inMantissa, 0),
            A(.always, F.bingo, .base, 7),
        ],
        .inXMLEntityFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("#"), F.next, .inXMLEntityNumFirst, 0),
            A(.ascLet, F.next, .inXMLEntity, 0),
            A(.eq(":"), F.next, .inXMLEntity, 0),
            A(.eq("_"), F.next, .inXMLEntity, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntity: [
            A(.eof, F.pop, nil, 0),
            A(.alnum, F.next, .inXMLEntity, 0),
            A(.eq(":"), F.next, .inXMLEntity, 0),
            A(.eq("_"), F.next, .inXMLEntity, 0),
            A(.eq("."), F.next, .inXMLEntity, 0),
            A(.eq("-"), F.next, .inXMLEntity, 0),
            A(.eq(";"), F.next, .inXMLEntityEnd, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntityNumFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("x"), F.next, .inXMLEntityHexNumFirst, 0),
            A(.eq("X"), F.next, .inXMLEntityHexNumFirst, 0),
            A(.digit, F.next, .inXMLEntityNum, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntityHexNumFirst: [
            A(.eof, F.pop, nil, 0),
            A(.xdigit, F.next, .inXMLEntityHexNum, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntityNum: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, .inXMLEntityNum, 0),
            A(.eq(";"), F.next, .inXMLEntityEnd, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntityHexNum: [
            A(.eof, F.pop, nil, 0),
            A(.xdigit, F.next, .inXMLEntityHexNum, 0),
            A(.eq(";"), F.next, .inXMLEntityEnd, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLEntityEnd: [
            A(.always, F.bingo | F.clear, .base, 23),
        ],
        .inTagFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("/"), F.push, .inTagCloseFirst, 0),
            A(.eq("!"), F.push, .inCommentFirst, 0),
            A(.eq("?"), F.push, .inXMLBegin, 0),
            A(.ascLet, F.push, .inTagName, 0),
            A(.eq(":"), F.push, .inTagName, 0),
            A(.eq("_"), F.push, .inTagName, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inXMLBegin: [
            A(.eof, F.pop, nil, 0),
            A(.eq("x"), F.next, .inTag, 0),
            A(.eq("X"), F.next, .inTag, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inTagCloseFirst: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inTagName, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inTagName: [
            A(.eof, F.pop, nil, 0),
            A(.eq("/"), F.next, .inTagBeginEnd, 0),
            A(.eq(">"), F.next, .inTagEnd, 0, .tags),
            A(.space, F.next, .inTag, 0, .tags),
            A(.alnum, F.next, nil, 0),
            A(.eq(":"), F.next, nil, 0),
            A(.eq("_"), F.next, nil, 0),
            A(.eq("."), F.next, nil, 0),
            A(.eq("-"), F.next, nil, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inTagBeginEnd: [
            A(.eof, F.pop, nil, 0),
            A(.eq(">"), F.next, .inTagEnd, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inTag: [
            A(.eof, F.pop, nil, 0),
            A(.eq(">"), F.next, .inTagEnd, 0, .tags),
            A(.eq("'"), F.next, .inTagEscapeK, 0),
            A(.eq("\""), F.next, .inTagEscapeKK, 0),
            A(.ascLet, F.next, nil, 0),
            A(.digit, F.next, nil, 0),
            A(.eq("="), F.next, nil, 0),
            A(.eq("-"), F.next, nil, 0),
            A(.eq("_"), F.next, nil, 0),
            A(.eq("#"), F.next, nil, 0),
            A(.eq("/"), F.next, nil, 0),
            A(.eq(":"), F.next, nil, 0),
            A(.eq("."), F.next, nil, 0),
            A(.eq("&"), F.next, nil, 0),
            A(.eq("?"), F.next, nil, 0),
            A(.eq("%"), F.next, nil, 0),
            A(.eq("~"), F.next, nil, 0),
            A(.space, F.next, nil, 0, .tags),
            A(.always, F.pop, nil, 0),
        ],
        .inTagEscapeK: [
            A(.eof, F.pop, nil, 0),
            A(.eq("\\"), F.push, .inTagBackSleshed, 0),
            A(.eq("'"), F.next, .inTag, 0),
            A(.always, F.next, .inTagEscapeK, 0),
        ],
        .inTagEscapeKK: [
            A(.eof, F.pop, nil, 0),
            A(.eq("\\"), F.push, .inTagBackSleshed, 0),
            A(.eq("\""), F.next, .inTag, 0),
            A(.always, F.next, .inTagEscapeKK, 0),
        ],
        .inTagBackSleshed: [
            A(.eof, F.pop, nil, 0),
            A(.always, F.merge, nil, 0),
        ],
        .inTagEnd: [
            A(.always, F.bingo | F.clrall, .base, 13),
        ],
        .inCommentFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("-"), F.next, .inCommentLast, 0),
            A(.eq("D"), F.next, .inTag, 0),
            A(.eq("d"), F.next, .inTag, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inCommentLast: [
            A(.eof, F.pop, nil, 0),
            A(.eq("-"), F.next, .inComment, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inComment: [
            A(.eof, F.pop, nil, 0),
            A(.eq("-"), F.next, .inCloseCommentFirst, 0),
            A(.always, F.next, nil, 0),
        ],
        .inCloseCommentFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("-"), F.next, .inCloseCommentLast, 0),
            A(.always, F.next, .inComment, 0),
        ],
        .inCloseCommentLast: [
            A(.eof, F.pop, nil, 0),
            A(.eq("-"), F.next, nil, 0),
            A(.eq(">"), F.next, .inCommentEnd, 0),
            A(.always, F.next, .inComment, 0),
        ],
        .inCommentEnd: [
            A(.always, F.bingo | F.clrall, .base, 13),
        ],
        .inHostFirstDomain: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inHostDomainSecond, 0),
            A(.digit, F.next, .inHost, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHostDomainSecond: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inHostDomain, 0),
            A(.digit, F.push, .inHost, 0),
            A(.eq("-"), F.push, .inHostFirstAN, 0),
            A(.eq("_"), F.push, .inHostFirstAN, 0),
            A(.eq("."), F.push, .inHostFirstDomain, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHostDomain: [
            A(.eof, F.bingo | F.clrall, .base, 6),
            A(.ascLet, F.next, .inHostDomain, 0),
            A(.digit, F.push, .inHost, 0),
            A(.eq(":"), F.push, .inPortFirst, 0),
            A(.eq("-"), F.push, .inHostFirstAN, 0),
            A(.eq("_"), F.push, .inHostFirstAN, 0),
            A(.eq("."), F.push, .inHostFirstDomain, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.digit, F.pop, nil, 0),
            A(.stopHost, F.bingo | F.clrall, .inURLPathStart, 6),
            A(.eq("/"), F.push, .inFURL, 0),
            A(.always, F.bingo | F.clrall, .base, 6),
        ],
        .inPortFirst: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, .inPort, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inPort: [
            A(.eof, F.bingo | F.clrall, .base, 6),
            A(.digit, F.next, .inPort, 0),
            A(.stopHost, F.bingo | F.clrall, .inURLPathStart, 6),
            A(.eq("/"), F.push, .inFURL, 0),
            A(.always, F.bingo | F.clrall, .base, 6),
        ],
        .inHostFirstAN: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, .inHost, 0),
            A(.ascLet, F.next, .inHost, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHost: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, .inHost, 0),
            A(.ascLet, F.next, .inHost, 0),
            A(.eq("@"), F.push, .inEmail, 0),
            A(.eq("."), F.push, .inHostFirstDomain, 0),
            A(.eq("-"), F.push, .inHostFirstAN, 0),
            A(.eq("_"), F.push, .inHostFirstAN, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inEmail: [
            A(.stopHost, F.pop, nil, 0),
            A(.host, F.bingo | F.clrall, .base, 4),
            A(.always, F.pop, nil, 0),
        ],
        .inFileFirst: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inFile, 0),
            A(.digit, F.next, .inFile, 0),
            A(.eq("."), F.next, .inPathFirst, 0),
            A(.eq("_"), F.next, .inFile, 0),
            A(.eq("~"), F.push, .inFileTwiddle, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inFileTwiddle: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inFile, 0),
            A(.digit, F.next, .inFile, 0),
            A(.eq("_"), F.next, .inFile, 0),
            A(.eq("/"), F.next, .inFileFirst, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inPathFirst: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inFile, 0),
            A(.digit, F.next, .inFile, 0),
            A(.eq("_"), F.next, .inFile, 0),
            A(.eq("."), F.next, .inPathSecond, 0),
            A(.eq("/"), F.next, .inFileFirst, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inPathFirstFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("."), F.next, .inPathSecond, 0),
            A(.eq("/"), F.next, .inFileFirst, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inPathSecond: [
            A(.eof, F.bingo | F.clear, .base, 19),
            A(.eq("/"), F.next | F.push, .inFileFirst, 0),
            A(.eq("/"), F.bingo | F.clear, .base, 19),
            A(.space, F.bingo | F.clear, .base, 19),
            A(.always, F.pop, nil, 0),
        ],
        .inFile: [
            A(.eof, F.bingo, .base, 19),
            A(.ascLet, F.next, .inFile, 0),
            A(.digit, F.next, .inFile, 0),
            A(.eq("."), F.push, .inFileNext, 0),
            A(.eq("_"), F.next, .inFile, 0),
            A(.eq("-"), F.next, .inFile, 0),
            A(.eq("/"), F.push, .inFileFirst, 0),
            A(.always, F.bingo, .base, 19),
        ],
        .inFileNext: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.clear, .inFile, 0),
            A(.digit, F.clear, .inFile, 0),
            A(.eq("_"), F.clear, .inFile, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inURLPathFirst: [
            A(.eof, F.pop, nil, 0),
            A(.urlChar, F.next, .inURLPath, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inURLPathStart: [
            A(.always, F.next, .inURLPath, 0),
        ],
        .inURLPath: [
            A(.eof, F.bingo, .base, 18),
            A(.urlChar, F.next, .inURLPath, 0),
            A(.always, F.bingo, .base, 18),
        ],
        .inFURL: [
            A(.eof, F.pop, nil, 0),
            A(.urlPath, F.bingo | F.clrall, .base, 5, .furl),
            A(.always, F.pop, nil, 0),
        ],
        .inProtocolFirst: [
            A(.eof, F.pop, nil, 0),
            A(.eq("/"), F.next, .inProtocolSecond, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inProtocolSecond: [
            A(.eof, F.pop, nil, 0),
            A(.eq("/"), F.next, .inProtocolEnd, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inProtocolEnd: [
            A(.always, F.bingo | F.clrall, .base, 14),
        ],
        .inHyphenAsciiWordFirst: [
            A(.eof, F.pop, nil, 0),
            A(.ascLet, F.next, .inHyphenAsciiWord, 0),
            A(.alpha, F.next, .inHyphenWord, 0),
            A(.special, F.next, .inHyphenWord, 0),
            A(.digit, F.next, .inHyphenDigitLookahead, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHyphenAsciiWord: [
            A(.eof, F.bingo | F.clrall, .inParseHyphen, 16, .hyphen),
            A(.ascLet, F.next, .inHyphenAsciiWord, 0),
            A(.alpha, F.next, .inHyphenWord, 0),
            A(.special, F.next, .inHyphenWord, 0),
            A(.digit, F.next, .inHyphenNumWord, 0),
            A(.eq("-"), F.push, .inHyphenAsciiWordFirst, 0),
            A(.always, F.bingo | F.clrall, .inParseHyphen, 16, .hyphen),
        ],
        .inHyphenWordFirst: [
            A(.eof, F.pop, nil, 0),
            A(.alpha, F.next, .inHyphenWord, 0),
            A(.special, F.next, .inHyphenWord, 0),
            A(.digit, F.next, .inHyphenDigitLookahead, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHyphenWord: [
            A(.eof, F.bingo | F.clrall, .inParseHyphen, 17, .hyphen),
            A(.alpha, F.next, .inHyphenWord, 0),
            A(.special, F.next, .inHyphenWord, 0),
            A(.digit, F.next, .inHyphenNumWord, 0),
            A(.eq("-"), F.push, .inHyphenWordFirst, 0),
            A(.always, F.bingo | F.clrall, .inParseHyphen, 17, .hyphen),
        ],
        .inHyphenNumWordFirst: [
            A(.eof, F.pop, nil, 0),
            A(.alpha, F.next, .inHyphenNumWord, 0),
            A(.special, F.next, .inHyphenNumWord, 0),
            A(.digit, F.next, .inHyphenDigitLookahead, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inHyphenNumWord: [
            A(.eof, F.bingo | F.clrall, .inParseHyphen, 15, .hyphen),
            A(.alnum, F.next, .inHyphenNumWord, 0),
            A(.special, F.next, .inHyphenNumWord, 0),
            A(.eq("-"), F.push, .inHyphenNumWordFirst, 0),
            A(.always, F.bingo | F.clrall, .inParseHyphen, 15, .hyphen),
        ],
        .inHyphenDigitLookahead: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, .inHyphenDigitLookahead, 0),
            A(.alpha, F.next, .inHyphenNumWord, 0),
            A(.special, F.next, .inHyphenNumWord, 0),
            A(.always, F.pop, nil, 0),
        ],
        .inParseHyphen: [
            A(.eof, F.rerun, .base, 0),
            A(.ascLet, F.next, .inHyphenAsciiWordPart, 0),
            A(.alpha, F.next, .inHyphenWordPart, 0),
            A(.special, F.push, .inHyphenWordPart, 0),
            A(.digit, F.push, .inHyphenUnsignedInt, 0),
            A(.eq("-"), F.push, .inParseHyphenHyphen, 0),
            A(.always, F.rerun, .base, 0),
        ],
        .inParseHyphenHyphen: [
            A(.eof, F.pop, nil, 0),
            A(.alnum, F.bingo | F.clear, .inParseHyphen, 12),
            A(.special, F.bingo | F.clear, .inParseHyphen, 12),
            A(.always, F.pop, nil, 0),
        ],
        .inHyphenWordPart: [
            A(.eof, F.bingo, .base, 10),
            A(.alpha, F.next, .inHyphenWordPart, 0),
            A(.special, F.next, .inHyphenWordPart, 0),
            A(.digit, F.next, .inHyphenNumWordPart, 0),
            A(.always, F.bingo, .inParseHyphen, 10),
        ],
        .inHyphenAsciiWordPart: [
            A(.eof, F.bingo, .base, 11),
            A(.ascLet, F.next, .inHyphenAsciiWordPart, 0),
            A(.alpha, F.next, .inHyphenWordPart, 0),
            A(.special, F.next, .inHyphenWordPart, 0),
            A(.digit, F.next, .inHyphenNumWordPart, 0),
            A(.always, F.bingo, .inParseHyphen, 11),
        ],
        .inHyphenNumWordPart: [
            A(.eof, F.bingo, .base, 9),
            A(.alnum, F.next, .inHyphenNumWordPart, 0),
            A(.special, F.next, .inHyphenNumWordPart, 0),
            A(.always, F.bingo, .inParseHyphen, 9),
        ],
        .inHyphenUnsignedInt: [
            A(.eof, F.pop, nil, 0),
            A(.digit, F.next, nil, 0),
            A(.alpha, F.clear, .inHyphenNumWordPart, 0),
            A(.special, F.clear, .inHyphenNumWordPart, 0),
            A(.always, F.pop, nil, 0),
        ],
    ]

    public struct Token: Sendable, Equatable {
        public let type: Int
        public let text: String
    }

    final class Position {
        var state: State
        var pos: Int
        /// Characters in the token so far.
        var len: Int
        /// Index of the action that pushed this position, to resume after a POP.
        var pushedAt: Int?
        var prev: Position?

        init(_ state: State, _ pos: Int, _ len: Int, _ pushedAt: Int?, _ prev: Position?) {
            self.state = state
            self.pos = pos
            self.len = len
            self.pushedAt = pushedAt
            self.prev = prev
        }
    }

    /// TParser: the default parser over the code points of a text.
    final class Parser {
        let chars: [Unicode.Scalar]
        var top: Position
        var wantHost = false
        var ignore = false
        var tokenStart = 0

        init(_ chars: [Unicode.Scalar], start: Int = 0) {
            self.chars = chars
            self.top = Position(.base, start, 0, nil, nil)
        }

        var pos: Int { top.pos }
        var atEnd: Bool { top.pos >= chars.count }
        var code: UInt32 { atEnd ? 0 : chars[top.pos].value }

        /// A parser over the rest of the text, as TParserCopyInit.
        func copy(at state: State) -> Parser {
            let sub = Parser(chars, start: top.pos)
            if state != .base { sub.top = Position(state, top.pos, 0, nil, sub.top) }
            return sub
        }

        func advance(by count: Int) {
            top.pos += count
            top.len += count
        }

        private var isAlnum: Bool {
            let c = code
            return c > 0x7F || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
        }

        func passes(_ test: Test) -> Bool {
            let c = code
            switch test {
            case .always: return true
            case .eof: return atEnd
            case .eq(let scalar): return !atEnd && chars[top.pos] == scalar
            case .alnum: return isAlnum
            case .alpha: return c > 0x7F || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
            case .digit: return c >= 48 && c <= 57
            case .xdigit: return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
            case .space: return c == 32 || (c >= 9 && c <= 13)
            case .notAlnum: return !isAlnum
            case .ascLet: return !atEnd && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))
            // Zero-width characters; in the C locale they are already letters.
            case .special: return false
            case .ignore: return ignore
            case .stopHost:
                if wantHost {
                    wantHost = false
                    return true
                }
                return false
            case .urlChar:
                if atEnd || c <= 0x20 || c >= 0x7F { return false }
                return !"\"<>\\^`{|}".unicodeScalars.contains(chars[top.pos])
            case .host:
                // Lookahead: does a host start here? Consumes it when it does.
                let sub = copy(at: .base)
                sub.wantHost = true
                if let token = sub.next(), token.type == SQLFullText.host {
                    advance(by: token.text.unicodeScalars.count)
                    return true
                }
                return false
            case .urlPath:
                let sub = copy(at: .inURLPathFirst)
                if let token = sub.next(), token.type == SQLFullText.urlPath {
                    advance(by: token.text.unicodeScalars.count)
                    return true
                }
                return false
            }
        }

        func apply(_ special: Special) {
            switch special {
            case .tags:
                let end = min(tokenStart + top.len, chars.count)
                let token = String(String.UnicodeScalarView(chars[tokenStart..<end])).lowercased()
                if token == "</script" || token == "</style" {
                    ignore = false
                } else if token == "<script" || token == "<style" {
                    ignore = true
                }
            case .furl:
                wantHost = true
                top.pos -= top.len
            case .hyphen:
                top.pos -= top.len
            case .verVersion:
                top.pos -= top.len
                top.len = 0
            }
        }

        /// TParserGet(): the next token, or nil at the end of the text.
        func next() -> Token? {
            if atEnd { return nil }
            tokenStart = top.pos
            top.pushedAt = nil
            var found: Token?
            while true {
                let actions = SQLFullText.actions[top.state] ?? []
                var index = 0
                if let pushedAt = top.pushedAt {
                    index = pushedAt + 1
                    top.pushedAt = nil
                }
                while index < actions.count, !passes(actions[index].test) { index += 1 }
                guard index < actions.count else { return found }
                let action = actions[index]
                if let special = action.special { apply(special) }
                if action.flags & F.bingo != 0 {
                    let end = min(tokenStart + top.len, chars.count)
                    found = Token(type: action.type, text: String(String.UnicodeScalarView(chars[tokenStart..<end])))
                    top.len = 0
                }
                if action.flags & F.pop != 0 {
                    guard let prev = top.prev else { return found }
                    top = prev
                } else if action.flags & F.push != 0 {
                    top.pushedAt = index
                    top = Position(top.state, top.pos, top.len, nil, top)
                } else if action.flags & F.clear != 0 {
                    if let prev = top.prev { top.prev = prev.prev }
                } else if action.flags & F.clrall != 0 {
                    top.prev = nil
                } else if action.flags & F.merge != 0 {
                    guard let prev = top.prev else { return found }
                    prev.pos = top.pos
                    prev.len = top.len
                    top = prev
                }
                if let to = action.to { top.state = to }
                if action.flags & F.bingo != 0 || (atEnd && action.flags & F.rerun == 0) { break }
                if action.flags & (F.rerun | F.pop) != 0 { continue }
                if !atEnd {
                    top.pos += 1
                    top.len += 1
                }
            }
            return found
        }
    }

    /// The default parser's tokens, as ts_parse('default', text) lists them.
    public static func parseTokens(_ text: String) -> [Token] {
        let parser = Parser(Array(text.unicodeScalars))
        var out: [Token] = []
        while let token = parser.next() { out.append(token) }
        return out
    }
}
