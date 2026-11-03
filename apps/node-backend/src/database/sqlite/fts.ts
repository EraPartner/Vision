/**
 * PostgreSQL full-text search for SQLite (ADR-263), replacing
 *
 *   to_tsvector('simple', doc) @@ websearch_to_tsquery('simple', q)
 *   ts_rank_cd(to_tsvector('simple', doc), websearch_to_tsquery('simple', q))
 *
 * with the same tokens, lexemes, positions, match results and ranks. The
 * pieces are ports of PostgreSQL 18 code, in a database with `--locale=C`:
 *
 *   - the default text search parser (wparser_def.c): its state machine is
 *     reproduced table for table, including backtracking (A_PUSH/A_POP),
 *     hyphenated words and their parts, hosts, URLs, e-mail addresses, file
 *     paths, numbers and versions. In the C locale every non-ASCII character
 *     counts as a letter;
 *   - the `simple` configuration: every token type except blank, tag,
 *     protocol and entity becomes a lexeme, lowercased in ASCII only;
 *   - websearch_to_tsquery (tsquery.c): implicit AND, `or`, `-` negation,
 *     quoted phrases, with multi-lexeme operands joined by `<->`;
 *   - the @@ operator and ts_rank_cd with normalization 0 (tsvector_op.c,
 *     tsrank.c): phrase matching with match widths, cover density ranking
 *     with the default weight 0.1 for unweighted positions, as float4.
 */

// ---------------------------------------------------------------------------
// The default parser
// ---------------------------------------------------------------------------

/** Token types (wparser_def.c), numbered as ts_token_type('default'). */
export const TOKEN_TYPES = [
  "", "asciiword", "word", "numword", "email", "url", "host", "sfloat", "version", "hword_numpart", "hword_part",
  "hword_asciipart", "blank", "tag", "protocol", "numhword", "asciihword", "hword", "url_path", "file", "float", "int",
  "uint", "entity",
] as const;

const ASCIIWORD = 1;
const WORD_T = 2;
const NUMWORD = 3;
const EMAIL = 4;
const URL_T = 5;
const HOST = 6;
const SCIENTIFIC = 7;
const VERSIONNUMBER = 8;
const NUMPARTHWORD = 9;
const PARTHWORD = 10;
const ASCIIPARTHWORD = 11;
const SPACE = 12;
const TAG_T = 13;
const PROTOCOL = 14;
const NUMHWORD = 15;
const ASCIIHWORD = 16;
const HWORD = 17;
const URLPATH = 18;
const FILEPATH = 19;
const DECIMAL_T = 20;
const SIGNEDINT = 21;
const UNSIGNEDINT = 22;
const XMLENTITY = 23;

/** Token types the `simple` configuration maps to the `simple` dictionary. */
const INDEXED = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22]);

const A_NEXT = 0;
const A_BINGO = 1;
const A_POP = 2;
const A_PUSH = 4;
const A_RERUN = 8;
const A_CLEAR = 16;
const A_MERGE = 32;
const A_CLRALL = 64;

type StateName =
  | "Base" | "InNumWord" | "InAsciiWord" | "InWord" | "InUnsignedInt" | "InSignedIntFirst" | "InSignedInt" | "InSpace"
  | "InUDecimalFirst" | "InUDecimal" | "InDecimalFirst" | "InDecimal" | "InVerVersion" | "InSVerVersion" | "InVersionFirst"
  | "InVersion" | "InMantissaFirst" | "InMantissaSign" | "InMantissa" | "InXMLEntityFirst" | "InXMLEntity"
  | "InXMLEntityNumFirst" | "InXMLEntityHexNumFirst" | "InXMLEntityNum" | "InXMLEntityHexNum" | "InXMLEntityEnd"
  | "InTagFirst" | "InXMLBegin" | "InTagCloseFirst" | "InTagName" | "InTagBeginEnd" | "InTag" | "InTagEscapeK"
  | "InTagEscapeKK" | "InTagBackSleshed" | "InTagEnd" | "InCommentFirst" | "InCommentLast" | "InComment"
  | "InCloseCommentFirst" | "InCloseCommentLast" | "InCommentEnd" | "InHostFirstDomain" | "InHostDomainSecond"
  | "InHostDomain" | "InPortFirst" | "InPort" | "InHostFirstAN" | "InHost" | "InEmail" | "InFileFirst" | "InFileTwiddle"
  | "InPathFirst" | "InPathFirstFirst" | "InPathSecond" | "InFile" | "InFileNext" | "InURLPathFirst" | "InURLPathStart"
  | "InURLPath" | "InFURL" | "InProtocolFirst" | "InProtocolSecond" | "InProtocolEnd" | "InHyphenAsciiWordFirst"
  | "InHyphenAsciiWord" | "InHyphenWordFirst" | "InHyphenWord" | "InHyphenNumWordFirst" | "InHyphenNumWord"
  | "InHyphenDigitLookahead" | "InParseHyphen" | "InParseHyphenHyphen" | "InHyphenWordPart" | "InHyphenAsciiWordPart"
  | "InHyphenNumWordPart" | "InHyphenUnsignedInt" | "Null";

interface Position {
  state: StateName;
  pos: number;
  /** Characters in the token so far. */
  len: number;
  /** Index of the action that pushed this position, to resume after a POP. */
  pushedAt: number | null;
  prev: Position | null;
}

type Test = (p: Parser) => boolean;
type Special = (p: Parser) => void;
type Action = readonly [test: Test | null, flags: number, to: StateName, type: number, special?: Special];

function code(p: Parser): number {
  return p.pos() < p.chars.length ? (p.chars[p.pos()]?.codePointAt(0) ?? 0) : 0;
}
const isEOF: Test = (p) => p.pos() >= p.chars.length;
const eq = (c: string): Test => (p) => p.chars[p.pos()] === c;
/** In the C locale with UTF-8 every non-ASCII character is a letter and alphanumeric, nothing else. */
const isAlnum: Test = (p) => {
  const c = code(p);
  return c > 0x7f || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};
const isAlpha: Test = (p) => {
  const c = code(p);
  return c > 0x7f || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};
const isDigit: Test = (p) => {
  const c = code(p);
  return c >= 48 && c <= 57;
};
const isXDigit: Test = (p) => {
  const c = code(p);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
};
const isSpace: Test = (p) => {
  const c = code(p);
  return c === 32 || (c >= 9 && c <= 13);
};
const isNotAlnum: Test = (p) => !isAlnum(p);
const isAscLet: Test = (p) => {
  const c = code(p);
  return !isEOF(p) && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122));
};
/** Zero-width characters; in the C locale they are already letters, so this never decides. */
const isSpecial: Test = () => false;
const isIgnore: Test = (p) => p.ignore;
const isStopHost: Test = (p) => {
  if (p.wantHost) {
    p.wantHost = false;
    return true;
  }
  return false;
};
const isURLChar: Test = (p) => {
  const c = code(p);
  if (isEOF(p) || c <= 0x20 || c >= 0x7f) return false;
  return !'"<>\\^`{|}'.includes(String.fromCharCode(c));
};
/** Lookahead: does a host start here? Consumes it when it does. */
const isHost: Test = (p) => {
  const sub = p.copyAt("Base");
  sub.wantHost = true;
  const tok = sub.next();
  if (tok !== null && tok.type === HOST) {
    p.advanceBy(tok.text.length);
    return true;
  }
  return false;
};
const isURLPath: Test = (p) => {
  const sub = p.copyAt("InURLPathFirst");
  const tok = sub.next();
  if (tok !== null && tok.type === URLPATH) {
    p.advanceBy(tok.text.length);
    return true;
  }
  return false;
};

const specialTags: Special = (p) => {
  const token = p.chars.slice(p.tokenStart, p.tokenStart + p.top().len).join("").toLowerCase();
  if (token.length === 8 && token === "</script") p.ignore = false;
  else if (token.length === 7 && token === "</style") p.ignore = false;
  else if (token.length === 7 && token === "<script") p.ignore = true;
  else if (token.length === 6 && token === "<style") p.ignore = true;
};
const specialFURL: Special = (p) => {
  p.wantHost = true;
  p.top().pos -= p.top().len;
};
const specialHyphen: Special = (p) => {
  p.top().pos -= p.top().len;
};
const specialVerVersion: Special = (p) => {
  p.top().pos -= p.top().len;
  p.top().len = 0;
};

const N: StateName = "Null";

const ACTIONS: Record<Exclude<StateName, "Null">, readonly Action[]> = {
  Base: [
    [isEOF, A_NEXT, N, 0],
    [eq("<"), A_PUSH, "InTagFirst", 0],
    [isIgnore, A_NEXT, "InSpace", 0],
    [isAscLet, A_NEXT, "InAsciiWord", 0],
    [isAlpha, A_NEXT, "InWord", 0],
    [isDigit, A_NEXT, "InUnsignedInt", 0],
    [eq("-"), A_PUSH, "InSignedIntFirst", 0],
    [eq("+"), A_PUSH, "InSignedIntFirst", 0],
    [eq("&"), A_PUSH, "InXMLEntityFirst", 0],
    [eq("~"), A_PUSH, "InFileTwiddle", 0],
    [eq("/"), A_PUSH, "InFileFirst", 0],
    [eq("."), A_PUSH, "InPathFirstFirst", 0],
    [null, A_NEXT, "InSpace", 0],
  ],
  InNumWord: [
    [isEOF, A_BINGO, "Base", NUMWORD],
    [isAlnum, A_NEXT, "InNumWord", 0],
    [isSpecial, A_NEXT, "InNumWord", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [eq("/"), A_PUSH, "InFileFirst", 0],
    [eq("."), A_PUSH, "InFileNext", 0],
    [eq("-"), A_PUSH, "InHyphenNumWordFirst", 0],
    [null, A_BINGO, "Base", NUMWORD],
  ],
  InAsciiWord: [
    [isEOF, A_BINGO, "Base", ASCIIWORD],
    [isAscLet, A_NEXT, N, 0],
    [eq("."), A_PUSH, "InHostFirstDomain", 0],
    [eq("."), A_PUSH, "InFileNext", 0],
    [eq("-"), A_PUSH, "InHostFirstAN", 0],
    [eq("-"), A_PUSH, "InHyphenAsciiWordFirst", 0],
    [eq("_"), A_PUSH, "InHostFirstAN", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [eq(":"), A_PUSH, "InProtocolFirst", 0],
    [eq("/"), A_PUSH, "InFileFirst", 0],
    [isDigit, A_PUSH, "InHost", 0],
    [isDigit, A_NEXT, "InNumWord", 0],
    [isAlpha, A_NEXT, "InWord", 0],
    [isSpecial, A_NEXT, "InWord", 0],
    [null, A_BINGO, "Base", ASCIIWORD],
  ],
  InWord: [
    [isEOF, A_BINGO, "Base", WORD_T],
    [isAlpha, A_NEXT, N, 0],
    [isSpecial, A_NEXT, N, 0],
    [isDigit, A_NEXT, "InNumWord", 0],
    [eq("-"), A_PUSH, "InHyphenWordFirst", 0],
    [null, A_BINGO, "Base", WORD_T],
  ],
  InUnsignedInt: [
    [isEOF, A_BINGO, "Base", UNSIGNEDINT],
    [isDigit, A_NEXT, N, 0],
    [eq("."), A_PUSH, "InHostFirstDomain", 0],
    [eq("."), A_PUSH, "InUDecimalFirst", 0],
    [eq("e"), A_PUSH, "InMantissaFirst", 0],
    [eq("E"), A_PUSH, "InMantissaFirst", 0],
    [eq("-"), A_PUSH, "InHostFirstAN", 0],
    [eq("_"), A_PUSH, "InHostFirstAN", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [isAscLet, A_PUSH, "InHost", 0],
    [isAlpha, A_NEXT, "InNumWord", 0],
    [isSpecial, A_NEXT, "InNumWord", 0],
    [eq("/"), A_PUSH, "InFileFirst", 0],
    [null, A_BINGO, "Base", UNSIGNEDINT],
  ],
  InSignedIntFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT | A_CLEAR, "InSignedInt", 0],
    [null, A_POP, N, 0],
  ],
  InSignedInt: [
    [isEOF, A_BINGO, "Base", SIGNEDINT],
    [isDigit, A_NEXT, N, 0],
    [eq("."), A_PUSH, "InDecimalFirst", 0],
    [eq("e"), A_PUSH, "InMantissaFirst", 0],
    [eq("E"), A_PUSH, "InMantissaFirst", 0],
    [null, A_BINGO, "Base", SIGNEDINT],
  ],
  InSpace: [
    [isEOF, A_BINGO, "Base", SPACE],
    [eq("<"), A_BINGO, "Base", SPACE],
    [isIgnore, A_NEXT, N, 0],
    [eq("-"), A_BINGO, "Base", SPACE],
    [eq("+"), A_BINGO, "Base", SPACE],
    [eq("&"), A_BINGO, "Base", SPACE],
    [eq("/"), A_BINGO, "Base", SPACE],
    [isNotAlnum, A_NEXT, "InSpace", 0],
    [null, A_BINGO, "Base", SPACE],
  ],
  InUDecimalFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_CLEAR, "InUDecimal", 0],
    [null, A_POP, N, 0],
  ],
  InUDecimal: [
    [isEOF, A_BINGO, "Base", DECIMAL_T],
    [isDigit, A_NEXT, "InUDecimal", 0],
    [eq("."), A_PUSH, "InVersionFirst", 0],
    [eq("e"), A_PUSH, "InMantissaFirst", 0],
    [eq("E"), A_PUSH, "InMantissaFirst", 0],
    [null, A_BINGO, "Base", DECIMAL_T],
  ],
  InDecimalFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_CLEAR, "InDecimal", 0],
    [null, A_POP, N, 0],
  ],
  InDecimal: [
    [isEOF, A_BINGO, "Base", DECIMAL_T],
    [isDigit, A_NEXT, "InDecimal", 0],
    [eq("."), A_PUSH, "InVerVersion", 0],
    [eq("e"), A_PUSH, "InMantissaFirst", 0],
    [eq("E"), A_PUSH, "InMantissaFirst", 0],
    [null, A_BINGO, "Base", DECIMAL_T],
  ],
  InVerVersion: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_RERUN, "InSVerVersion", 0, specialVerVersion],
    [null, A_POP, N, 0],
  ],
  InSVerVersion: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_BINGO | A_CLRALL, "InUnsignedInt", SPACE],
    [null, A_NEXT, N, 0],
  ],
  InVersionFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_CLEAR, "InVersion", 0],
    [null, A_POP, N, 0],
  ],
  InVersion: [
    [isEOF, A_BINGO, "Base", VERSIONNUMBER],
    [isDigit, A_NEXT, "InVersion", 0],
    [eq("."), A_PUSH, "InVersionFirst", 0],
    [null, A_BINGO, "Base", VERSIONNUMBER],
  ],
  InMantissaFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_CLEAR, "InMantissa", 0],
    [eq("+"), A_NEXT, "InMantissaSign", 0],
    [eq("-"), A_NEXT, "InMantissaSign", 0],
    [null, A_POP, N, 0],
  ],
  InMantissaSign: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_CLEAR, "InMantissa", 0],
    [null, A_POP, N, 0],
  ],
  InMantissa: [
    [isEOF, A_BINGO, "Base", SCIENTIFIC],
    [isDigit, A_NEXT, "InMantissa", 0],
    [null, A_BINGO, "Base", SCIENTIFIC],
  ],
  InXMLEntityFirst: [
    [isEOF, A_POP, N, 0],
    [eq("#"), A_NEXT, "InXMLEntityNumFirst", 0],
    [isAscLet, A_NEXT, "InXMLEntity", 0],
    [eq(":"), A_NEXT, "InXMLEntity", 0],
    [eq("_"), A_NEXT, "InXMLEntity", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntity: [
    [isEOF, A_POP, N, 0],
    [isAlnum, A_NEXT, "InXMLEntity", 0],
    [eq(":"), A_NEXT, "InXMLEntity", 0],
    [eq("_"), A_NEXT, "InXMLEntity", 0],
    [eq("."), A_NEXT, "InXMLEntity", 0],
    [eq("-"), A_NEXT, "InXMLEntity", 0],
    [eq(";"), A_NEXT, "InXMLEntityEnd", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntityNumFirst: [
    [isEOF, A_POP, N, 0],
    [eq("x"), A_NEXT, "InXMLEntityHexNumFirst", 0],
    [eq("X"), A_NEXT, "InXMLEntityHexNumFirst", 0],
    [isDigit, A_NEXT, "InXMLEntityNum", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntityHexNumFirst: [
    [isEOF, A_POP, N, 0],
    [isXDigit, A_NEXT, "InXMLEntityHexNum", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntityNum: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, "InXMLEntityNum", 0],
    [eq(";"), A_NEXT, "InXMLEntityEnd", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntityHexNum: [
    [isEOF, A_POP, N, 0],
    [isXDigit, A_NEXT, "InXMLEntityHexNum", 0],
    [eq(";"), A_NEXT, "InXMLEntityEnd", 0],
    [null, A_POP, N, 0],
  ],
  InXMLEntityEnd: [[null, A_BINGO | A_CLEAR, "Base", XMLENTITY]],
  InTagFirst: [
    [isEOF, A_POP, N, 0],
    [eq("/"), A_PUSH, "InTagCloseFirst", 0],
    [eq("!"), A_PUSH, "InCommentFirst", 0],
    [eq("?"), A_PUSH, "InXMLBegin", 0],
    [isAscLet, A_PUSH, "InTagName", 0],
    [eq(":"), A_PUSH, "InTagName", 0],
    [eq("_"), A_PUSH, "InTagName", 0],
    [null, A_POP, N, 0],
  ],
  InXMLBegin: [
    [isEOF, A_POP, N, 0],
    [eq("x"), A_NEXT, "InTag", 0],
    [eq("X"), A_NEXT, "InTag", 0],
    [null, A_POP, N, 0],
  ],
  InTagCloseFirst: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InTagName", 0],
    [null, A_POP, N, 0],
  ],
  InTagName: [
    [isEOF, A_POP, N, 0],
    [eq("/"), A_NEXT, "InTagBeginEnd", 0],
    [eq(">"), A_NEXT, "InTagEnd", 0, specialTags],
    [isSpace, A_NEXT, "InTag", 0, specialTags],
    [isAlnum, A_NEXT, N, 0],
    [eq(":"), A_NEXT, N, 0],
    [eq("_"), A_NEXT, N, 0],
    [eq("."), A_NEXT, N, 0],
    [eq("-"), A_NEXT, N, 0],
    [null, A_POP, N, 0],
  ],
  InTagBeginEnd: [
    [isEOF, A_POP, N, 0],
    [eq(">"), A_NEXT, "InTagEnd", 0],
    [null, A_POP, N, 0],
  ],
  InTag: [
    [isEOF, A_POP, N, 0],
    [eq(">"), A_NEXT, "InTagEnd", 0, specialTags],
    [eq("'"), A_NEXT, "InTagEscapeK", 0],
    [eq('"'), A_NEXT, "InTagEscapeKK", 0],
    [isAscLet, A_NEXT, N, 0],
    [isDigit, A_NEXT, N, 0],
    [eq("="), A_NEXT, N, 0],
    [eq("-"), A_NEXT, N, 0],
    [eq("_"), A_NEXT, N, 0],
    [eq("#"), A_NEXT, N, 0],
    [eq("/"), A_NEXT, N, 0],
    [eq(":"), A_NEXT, N, 0],
    [eq("."), A_NEXT, N, 0],
    [eq("&"), A_NEXT, N, 0],
    [eq("?"), A_NEXT, N, 0],
    [eq("%"), A_NEXT, N, 0],
    [eq("~"), A_NEXT, N, 0],
    [isSpace, A_NEXT, N, 0, specialTags],
    [null, A_POP, N, 0],
  ],
  InTagEscapeK: [
    [isEOF, A_POP, N, 0],
    [eq("\\"), A_PUSH, "InTagBackSleshed", 0],
    [eq("'"), A_NEXT, "InTag", 0],
    [null, A_NEXT, "InTagEscapeK", 0],
  ],
  InTagEscapeKK: [
    [isEOF, A_POP, N, 0],
    [eq("\\"), A_PUSH, "InTagBackSleshed", 0],
    [eq('"'), A_NEXT, "InTag", 0],
    [null, A_NEXT, "InTagEscapeKK", 0],
  ],
  InTagBackSleshed: [
    [isEOF, A_POP, N, 0],
    [null, A_MERGE, N, 0],
  ],
  InTagEnd: [[null, A_BINGO | A_CLRALL, "Base", TAG_T]],
  InCommentFirst: [
    [isEOF, A_POP, N, 0],
    [eq("-"), A_NEXT, "InCommentLast", 0],
    [eq("D"), A_NEXT, "InTag", 0],
    [eq("d"), A_NEXT, "InTag", 0],
    [null, A_POP, N, 0],
  ],
  InCommentLast: [
    [isEOF, A_POP, N, 0],
    [eq("-"), A_NEXT, "InComment", 0],
    [null, A_POP, N, 0],
  ],
  InComment: [
    [isEOF, A_POP, N, 0],
    [eq("-"), A_NEXT, "InCloseCommentFirst", 0],
    [null, A_NEXT, N, 0],
  ],
  InCloseCommentFirst: [
    [isEOF, A_POP, N, 0],
    [eq("-"), A_NEXT, "InCloseCommentLast", 0],
    [null, A_NEXT, "InComment", 0],
  ],
  InCloseCommentLast: [
    [isEOF, A_POP, N, 0],
    [eq("-"), A_NEXT, N, 0],
    [eq(">"), A_NEXT, "InCommentEnd", 0],
    [null, A_NEXT, "InComment", 0],
  ],
  InCommentEnd: [[null, A_BINGO | A_CLRALL, "Base", TAG_T]],
  InHostFirstDomain: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InHostDomainSecond", 0],
    [isDigit, A_NEXT, "InHost", 0],
    [null, A_POP, N, 0],
  ],
  InHostDomainSecond: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InHostDomain", 0],
    [isDigit, A_PUSH, "InHost", 0],
    [eq("-"), A_PUSH, "InHostFirstAN", 0],
    [eq("_"), A_PUSH, "InHostFirstAN", 0],
    [eq("."), A_PUSH, "InHostFirstDomain", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [null, A_POP, N, 0],
  ],
  InHostDomain: [
    [isEOF, A_BINGO | A_CLRALL, "Base", HOST],
    [isAscLet, A_NEXT, "InHostDomain", 0],
    [isDigit, A_PUSH, "InHost", 0],
    [eq(":"), A_PUSH, "InPortFirst", 0],
    [eq("-"), A_PUSH, "InHostFirstAN", 0],
    [eq("_"), A_PUSH, "InHostFirstAN", 0],
    [eq("."), A_PUSH, "InHostFirstDomain", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [isDigit, A_POP, N, 0],
    [isStopHost, A_BINGO | A_CLRALL, "InURLPathStart", HOST],
    [eq("/"), A_PUSH, "InFURL", 0],
    [null, A_BINGO | A_CLRALL, "Base", HOST],
  ],
  InPortFirst: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, "InPort", 0],
    [null, A_POP, N, 0],
  ],
  InPort: [
    [isEOF, A_BINGO | A_CLRALL, "Base", HOST],
    [isDigit, A_NEXT, "InPort", 0],
    [isStopHost, A_BINGO | A_CLRALL, "InURLPathStart", HOST],
    [eq("/"), A_PUSH, "InFURL", 0],
    [null, A_BINGO | A_CLRALL, "Base", HOST],
  ],
  InHostFirstAN: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, "InHost", 0],
    [isAscLet, A_NEXT, "InHost", 0],
    [null, A_POP, N, 0],
  ],
  InHost: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, "InHost", 0],
    [isAscLet, A_NEXT, "InHost", 0],
    [eq("@"), A_PUSH, "InEmail", 0],
    [eq("."), A_PUSH, "InHostFirstDomain", 0],
    [eq("-"), A_PUSH, "InHostFirstAN", 0],
    [eq("_"), A_PUSH, "InHostFirstAN", 0],
    [null, A_POP, N, 0],
  ],
  InEmail: [
    [isStopHost, A_POP, N, 0],
    [isHost, A_BINGO | A_CLRALL, "Base", EMAIL],
    [null, A_POP, N, 0],
  ],
  InFileFirst: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InFile", 0],
    [isDigit, A_NEXT, "InFile", 0],
    [eq("."), A_NEXT, "InPathFirst", 0],
    [eq("_"), A_NEXT, "InFile", 0],
    [eq("~"), A_PUSH, "InFileTwiddle", 0],
    [null, A_POP, N, 0],
  ],
  InFileTwiddle: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InFile", 0],
    [isDigit, A_NEXT, "InFile", 0],
    [eq("_"), A_NEXT, "InFile", 0],
    [eq("/"), A_NEXT, "InFileFirst", 0],
    [null, A_POP, N, 0],
  ],
  InPathFirst: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InFile", 0],
    [isDigit, A_NEXT, "InFile", 0],
    [eq("_"), A_NEXT, "InFile", 0],
    [eq("."), A_NEXT, "InPathSecond", 0],
    [eq("/"), A_NEXT, "InFileFirst", 0],
    [null, A_POP, N, 0],
  ],
  InPathFirstFirst: [
    [isEOF, A_POP, N, 0],
    [eq("."), A_NEXT, "InPathSecond", 0],
    [eq("/"), A_NEXT, "InFileFirst", 0],
    [null, A_POP, N, 0],
  ],
  InPathSecond: [
    [isEOF, A_BINGO | A_CLEAR, "Base", FILEPATH],
    [eq("/"), A_NEXT | A_PUSH, "InFileFirst", 0],
    [eq("/"), A_BINGO | A_CLEAR, "Base", FILEPATH],
    [isSpace, A_BINGO | A_CLEAR, "Base", FILEPATH],
    [null, A_POP, N, 0],
  ],
  InFile: [
    [isEOF, A_BINGO, "Base", FILEPATH],
    [isAscLet, A_NEXT, "InFile", 0],
    [isDigit, A_NEXT, "InFile", 0],
    [eq("."), A_PUSH, "InFileNext", 0],
    [eq("_"), A_NEXT, "InFile", 0],
    [eq("-"), A_NEXT, "InFile", 0],
    [eq("/"), A_PUSH, "InFileFirst", 0],
    [null, A_BINGO, "Base", FILEPATH],
  ],
  InFileNext: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_CLEAR, "InFile", 0],
    [isDigit, A_CLEAR, "InFile", 0],
    [eq("_"), A_CLEAR, "InFile", 0],
    [null, A_POP, N, 0],
  ],
  InURLPathFirst: [
    [isEOF, A_POP, N, 0],
    [isURLChar, A_NEXT, "InURLPath", 0],
    [null, A_POP, N, 0],
  ],
  InURLPathStart: [[null, A_NEXT, "InURLPath", 0]],
  InURLPath: [
    [isEOF, A_BINGO, "Base", URLPATH],
    [isURLChar, A_NEXT, "InURLPath", 0],
    [null, A_BINGO, "Base", URLPATH],
  ],
  InFURL: [
    [isEOF, A_POP, N, 0],
    [isURLPath, A_BINGO | A_CLRALL, "Base", URL_T, specialFURL],
    [null, A_POP, N, 0],
  ],
  InProtocolFirst: [
    [isEOF, A_POP, N, 0],
    [eq("/"), A_NEXT, "InProtocolSecond", 0],
    [null, A_POP, N, 0],
  ],
  InProtocolSecond: [
    [isEOF, A_POP, N, 0],
    [eq("/"), A_NEXT, "InProtocolEnd", 0],
    [null, A_POP, N, 0],
  ],
  InProtocolEnd: [[null, A_BINGO | A_CLRALL, "Base", PROTOCOL]],
  InHyphenAsciiWordFirst: [
    [isEOF, A_POP, N, 0],
    [isAscLet, A_NEXT, "InHyphenAsciiWord", 0],
    [isAlpha, A_NEXT, "InHyphenWord", 0],
    [isSpecial, A_NEXT, "InHyphenWord", 0],
    [isDigit, A_NEXT, "InHyphenDigitLookahead", 0],
    [null, A_POP, N, 0],
  ],
  InHyphenAsciiWord: [
    [isEOF, A_BINGO | A_CLRALL, "InParseHyphen", ASCIIHWORD, specialHyphen],
    [isAscLet, A_NEXT, "InHyphenAsciiWord", 0],
    [isAlpha, A_NEXT, "InHyphenWord", 0],
    [isSpecial, A_NEXT, "InHyphenWord", 0],
    [isDigit, A_NEXT, "InHyphenNumWord", 0],
    [eq("-"), A_PUSH, "InHyphenAsciiWordFirst", 0],
    [null, A_BINGO | A_CLRALL, "InParseHyphen", ASCIIHWORD, specialHyphen],
  ],
  InHyphenWordFirst: [
    [isEOF, A_POP, N, 0],
    [isAlpha, A_NEXT, "InHyphenWord", 0],
    [isSpecial, A_NEXT, "InHyphenWord", 0],
    [isDigit, A_NEXT, "InHyphenDigitLookahead", 0],
    [null, A_POP, N, 0],
  ],
  InHyphenWord: [
    [isEOF, A_BINGO | A_CLRALL, "InParseHyphen", HWORD, specialHyphen],
    [isAlpha, A_NEXT, "InHyphenWord", 0],
    [isSpecial, A_NEXT, "InHyphenWord", 0],
    [isDigit, A_NEXT, "InHyphenNumWord", 0],
    [eq("-"), A_PUSH, "InHyphenWordFirst", 0],
    [null, A_BINGO | A_CLRALL, "InParseHyphen", HWORD, specialHyphen],
  ],
  InHyphenNumWordFirst: [
    [isEOF, A_POP, N, 0],
    [isAlpha, A_NEXT, "InHyphenNumWord", 0],
    [isSpecial, A_NEXT, "InHyphenNumWord", 0],
    [isDigit, A_NEXT, "InHyphenDigitLookahead", 0],
    [null, A_POP, N, 0],
  ],
  InHyphenNumWord: [
    [isEOF, A_BINGO | A_CLRALL, "InParseHyphen", NUMHWORD, specialHyphen],
    [isAlnum, A_NEXT, "InHyphenNumWord", 0],
    [isSpecial, A_NEXT, "InHyphenNumWord", 0],
    [eq("-"), A_PUSH, "InHyphenNumWordFirst", 0],
    [null, A_BINGO | A_CLRALL, "InParseHyphen", NUMHWORD, specialHyphen],
  ],
  InHyphenDigitLookahead: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, "InHyphenDigitLookahead", 0],
    [isAlpha, A_NEXT, "InHyphenNumWord", 0],
    [isSpecial, A_NEXT, "InHyphenNumWord", 0],
    [null, A_POP, N, 0],
  ],
  InParseHyphen: [
    [isEOF, A_RERUN, "Base", 0],
    [isAscLet, A_NEXT, "InHyphenAsciiWordPart", 0],
    [isAlpha, A_NEXT, "InHyphenWordPart", 0],
    [isSpecial, A_PUSH, "InHyphenWordPart", 0],
    [isDigit, A_PUSH, "InHyphenUnsignedInt", 0],
    [eq("-"), A_PUSH, "InParseHyphenHyphen", 0],
    [null, A_RERUN, "Base", 0],
  ],
  InParseHyphenHyphen: [
    [isEOF, A_POP, N, 0],
    [isAlnum, A_BINGO | A_CLEAR, "InParseHyphen", SPACE],
    [isSpecial, A_BINGO | A_CLEAR, "InParseHyphen", SPACE],
    [null, A_POP, N, 0],
  ],
  InHyphenWordPart: [
    [isEOF, A_BINGO, "Base", PARTHWORD],
    [isAlpha, A_NEXT, "InHyphenWordPart", 0],
    [isSpecial, A_NEXT, "InHyphenWordPart", 0],
    [isDigit, A_NEXT, "InHyphenNumWordPart", 0],
    [null, A_BINGO, "InParseHyphen", PARTHWORD],
  ],
  InHyphenAsciiWordPart: [
    [isEOF, A_BINGO, "Base", ASCIIPARTHWORD],
    [isAscLet, A_NEXT, "InHyphenAsciiWordPart", 0],
    [isAlpha, A_NEXT, "InHyphenWordPart", 0],
    [isSpecial, A_NEXT, "InHyphenWordPart", 0],
    [isDigit, A_NEXT, "InHyphenNumWordPart", 0],
    [null, A_BINGO, "InParseHyphen", ASCIIPARTHWORD],
  ],
  InHyphenNumWordPart: [
    [isEOF, A_BINGO, "Base", NUMPARTHWORD],
    [isAlnum, A_NEXT, "InHyphenNumWordPart", 0],
    [isSpecial, A_NEXT, "InHyphenNumWordPart", 0],
    [null, A_BINGO, "InParseHyphen", NUMPARTHWORD],
  ],
  InHyphenUnsignedInt: [
    [isEOF, A_POP, N, 0],
    [isDigit, A_NEXT, N, 0],
    [isAlpha, A_CLEAR, "InHyphenNumWordPart", 0],
    [isSpecial, A_CLEAR, "InHyphenNumWordPart", 0],
    [null, A_POP, N, 0],
  ],
};

export interface Token {
  readonly type: number;
  readonly text: string;
}

/** TParser: the default parser over the code points of a text. */
class Parser {
  readonly chars: readonly string[];
  private state: Position;
  wantHost = false;
  ignore = false;
  tokenStart = 0;

  constructor(chars: readonly string[], start = 0, state: StateName = "Base") {
    this.chars = chars;
    this.state = { state, pos: start, len: 0, pushedAt: null, prev: null };
  }

  top(): Position {
    return this.state;
  }

  pos(): number {
    return this.state.pos;
  }

  /** A parser over the rest of the text, as TParserCopyInit. */
  copyAt(state: StateName): Parser {
    const sub = new Parser(this.chars, this.state.pos, "Base");
    if (state !== "Base") {
      sub.state = { state, pos: this.state.pos, len: 0, pushedAt: null, prev: sub.state };
    }
    return sub;
  }

  advanceBy(n: number): void {
    this.state.pos += n;
    this.state.len += n;
  }

  /** TParserGet(): the next token, or null at the end of the text. */
  next(): Token | null {
    if (this.state.pos >= this.chars.length) return null;
    this.tokenStart = this.state.pos;
    this.state.pushedAt = null;
    let found: Token | null = null;
    for (;;) {
      if (this.state.state === "Null") throw new Error("text search parser reached the null state");
      const actions = ACTIONS[this.state.state];
      let index: number;
      if (this.state.pushedAt !== null) {
        index = this.state.pushedAt + 1;
        this.state.pushedAt = null;
      } else {
        index = 0;
      }
      let action = actions[index];
      while (action !== undefined && action[0] !== null && !action[0](this)) {
        index++;
        action = actions[index];
      }
      if (action === undefined) throw new Error(`text search parser has no default in ${this.state.state}`);
      const [, flags, to, type, special] = action;
      if (special) special(this);
      if (flags & A_BINGO) {
        const len = this.state.len;
        found = { type, text: this.chars.slice(this.tokenStart, this.tokenStart + len).join("") };
        this.state.len = 0;
      }
      if (flags & A_POP) {
        const prev = this.state.prev;
        if (prev === null) throw new Error("text search parser popped an empty stack");
        this.state = prev;
      } else if (flags & A_PUSH) {
        this.state.pushedAt = index;
        this.state = { ...this.state, pushedAt: null, prev: this.state };
      } else if (flags & A_CLEAR) {
        const prev = this.state.prev;
        if (prev !== null) this.state.prev = prev.prev;
      } else if (flags & A_CLRALL) {
        this.state.prev = null;
      } else if (flags & A_MERGE) {
        const cur = this.state;
        const prev = cur.prev;
        if (prev === null) throw new Error("text search parser merged an empty stack");
        prev.pos = cur.pos;
        prev.len = cur.len;
        this.state = prev;
      }
      if (to !== "Null") this.state.state = to;
      if (flags & A_BINGO || (this.state.pos >= this.chars.length && (flags & A_RERUN) === 0)) break;
      if (flags & (A_RERUN | A_POP)) continue;
      if (this.state.pos < this.chars.length) {
        this.state.pos++;
        this.state.len++;
      }
    }
    return found;
  }
}

/** The default parser's tokens, as ts_parse('default', text) lists them. */
export function parseTokens(text: string): Token[] {
  const parser = new Parser(Array.from(text));
  const out: Token[] = [];
  for (;;) {
    const tok = parser.next();
    if (tok === null) break;
    out.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// to_tsvector('simple', ...)
// ---------------------------------------------------------------------------

/** Lexeme -> sorted positions (1-based), as to_tsvector('simple', text). */
export type TsVector = ReadonlyMap<string, readonly number[]>;

/** PostgreSQL's MAXSTRLEN: longer words are dropped with a notice. */
const MAX_WORD_BYTES = 2047;
/** MAXENTRYPOS - 1: positions above it are clamped. */
const MAX_POS = 16383;
/** MAXNUMPOS - 1: positions kept per lexeme. */
const MAX_POSITIONS = 255;

const utf8 = new TextEncoder();

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** The `simple` dictionary's lexemes of a text, with their positions in order. */
function lexemes(text: string): { lexeme: string; pos: number }[] {
  const out: { lexeme: string; pos: number }[] = [];
  let pos = 0;
  for (const tok of parseTokens(text)) {
    if (!INDEXED.has(tok.type)) continue;
    if (utf8.encode(tok.text).length >= MAX_WORD_BYTES) continue;
    pos++;
    const lexeme = asciiLower(tok.text);
    if (lexeme.length === 0) continue;
    out.push({ lexeme, pos: Math.min(pos, MAX_POS) });
  }
  return out;
}

export function toTsvector(text: string): TsVector {
  const map = new Map<string, number[]>();
  for (const { lexeme, pos } of lexemes(text)) {
    let list = map.get(lexeme);
    if (list === undefined) {
      list = [];
      map.set(lexeme, list);
    }
    if (list.length < MAX_POSITIONS && list[list.length - 1] !== pos) list.push(pos);
  }
  return map;
}

/** Byte order of two strings (tsvector lexeme order). */
function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function quoteLexeme(s: string): string {
  return `'${s.replace(/['\\]/g, (c) => c + c)}'`;
}

/** tsvector text output, e.g. `'a':1 'b':2,3`. */
export function formatTsvector(vector: TsVector): string {
  return [...vector.entries()]
    .sort((a, b) => compareBytes(a[0], b[0]))
    .map(([lexeme, positions]) => `${quoteLexeme(lexeme)}:${positions.join(",")}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// websearch_to_tsquery('simple', ...)
// ---------------------------------------------------------------------------

export type TsQuery =
  | { readonly kind: "val"; readonly lexeme: string; readonly id: number }
  | { readonly kind: "not"; readonly arg: TsQuery }
  | { readonly kind: "and" | "or"; readonly left: TsQuery; readonly right: TsQuery }
  | { readonly kind: "phrase"; readonly left: TsQuery; readonly right: TsQuery; readonly distance: number };

/** A query under construction: `stop` marks an operand without lexemes. */
type Draft =
  | { kind: "val"; lexeme: string }
  | { kind: "stop" }
  | { kind: "not"; arg: Draft }
  | { kind: "and" | "or"; left: Draft; right: Draft }
  | { kind: "phrase"; left: Draft; right: Draft; distance: number };

type Op = "not" | "and" | "or" | "phrase";
const PRIORITY: Record<Op, number> = { or: 1, and: 2, phrase: 3, not: 4 };

/** tsquery.c ISOPERATOR. */
function isQueryOperator(c: string | undefined): boolean {
  return c === "!" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<";
}

function isQuerySpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
}

function isAsciiAlnum(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z0-9]$/.test(c);
}

/** pushval_morph(): an operand's lexemes joined by `<->`, or a stop placeholder. */
function operandDraft(text: string): Draft {
  const words = lexemes(text);
  let out: Draft | null = null;
  for (const w of words) {
    const val: Draft = { kind: "val", lexeme: w.lexeme };
    out = out === null ? val : { kind: "phrase", left: out, right: val, distance: 1 };
  }
  return out ?? { kind: "stop" };
}

/** gettoken_query_websearch() plus makepol(): the query in tree form. */
function parseWebsearch(query: string): Draft | null {
  const s = Array.from(query);
  let i = 0;
  type State = "first" | "operand" | "operator";
  let state: State = "first";
  const output: Draft[] = [];
  const stack: Op[] = [];
  const emit = (op: Op): void => {
    if (op === "not") {
      const arg = output.pop();
      if (arg === undefined) throw new Error("tsquery stack underflow");
      output.push({ kind: "not", arg });
      return;
    }
    const right = output.pop();
    const left = output.pop();
    if (right === undefined || left === undefined) throw new Error("tsquery stack underflow");
    output.push(op === "phrase" ? { kind: "phrase", left, right, distance: 1 } : { kind: op, left, right });
  };
  const pushOperator = (op: Op): void => {
    const priority = PRIORITY[op];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] ?? "or";
      if ((op !== "not" && priority > PRIORITY[top]) || (op === "not" && priority >= PRIORITY[top])) break;
      stack.pop();
      emit(top);
    }
    stack.push(op);
  };
  /** parse_or_operator(). */
  const isOr = (): boolean => {
    if ((s[i] ?? "").toLowerCase() !== "o" || (s[i + 1] ?? "").toLowerCase() !== "r") return false;
    let j = i + 2;
    const after = s[j];
    if (after === undefined) return false;
    if (after === "-" || after === "_" || isAsciiAlnum(after)) return false;
    for (;;) {
      j++;
      if (j >= s.length) return false;
      if (!isQuerySpace(s[j])) break;
    }
    i += 2;
    return true;
  };
  for (;;) {
    if (state === "first" || state === "operand") {
      const c = s[i];
      if (c === "-") {
        i++;
        state = "operand";
        pushOperator("not");
        continue;
      }
      if (c === '"') {
        i++;
        const start = i;
        while (i < s.length && s[i] !== '"') i++;
        const text = s.slice(start, i).join("");
        if (i < s.length) i++;
        output.push(operandDraft(text));
        state = "operator";
        continue;
      }
      if (isQueryOperator(c)) {
        i++;
        state = "operand";
        continue;
      }
      if (c === undefined) {
        if (state === "operand") output.push({ kind: "stop" });
        break;
      }
      if (!isQuerySpace(c)) {
        // gettoken_tsvector in websearch mode: a word up to a space, an operator, a quote or a colon.
        const start = i;
        i++;
        while (i < s.length && !isQuerySpace(s[i]) && !isQueryOperator(s[i]) && s[i] !== '"' && s[i] !== ":") i++;
        output.push(operandDraft(s.slice(start, i).join("")));
        state = "operator";
        continue;
      }
      i++;
    } else {
      const c = s[i];
      if (c === undefined) break;
      if (isOr()) {
        state = "operand";
        pushOperator("or");
        continue;
      }
      if (isQueryOperator(c)) {
        i++;
        continue;
      }
      if (!isQuerySpace(c)) {
        state = "operand";
        pushOperator("and");
        continue;
      }
      i++;
    }
  }
  while (stack.length > 0) emit(stack.pop() ?? "or");
  if (output.length === 0) return null;
  if (output.length !== 1) throw new Error("tsquery has unconnected operands");
  return output[0] ?? null;
}

/** clean_stopword_intree(): drop operands without lexemes, widening phrase distances. */
function removeStops(node: Draft): { node: Draft | null; ladd: number; radd: number } {
  switch (node.kind) {
    case "val":
      return { node, ladd: 0, radd: 0 };
    case "stop":
      return { node: null, ladd: 0, radd: 0 };
    case "not": {
      const r = removeStops(node.arg);
      return r.node === null ? { node: null, ladd: r.ladd, radd: r.radd } : { node: { kind: "not", arg: r.node }, ladd: r.ladd, radd: r.radd };
    }
    default: {
      const l = removeStops(node.left);
      const r = removeStops(node.right);
      const isPhrase = node.kind === "phrase";
      const distance = node.kind === "phrase" ? node.distance : 0;
      if (l.node === null && r.node === null) {
        const add = isPhrase ? l.ladd + distance + r.ladd : Math.max(l.ladd, r.ladd);
        return { node: null, ladd: add, radd: add };
      }
      if (l.node === null) {
        return isPhrase
          ? { node: r.node, ladd: l.ladd + distance + r.ladd, radd: r.radd }
          : { node: r.node, ladd: r.ladd, radd: r.radd };
      }
      if (r.node === null) {
        return isPhrase
          ? { node: l.node, ladd: l.ladd, radd: l.radd + distance + r.radd }
          : { node: l.node, ladd: l.ladd, radd: l.radd };
      }
      if (node.kind === "phrase") {
        return { node: { kind: "phrase", left: l.node, right: r.node, distance: distance + l.radd + r.ladd }, ladd: l.ladd, radd: r.radd };
      }
      return { node: { kind: node.kind, left: l.node, right: r.node }, ladd: 0, radd: 0 };
    }
  }
}

function freeze(node: Draft, ids: { next: number }): TsQuery {
  switch (node.kind) {
    case "val":
      return { kind: "val", lexeme: node.lexeme, id: ids.next++ };
    case "stop":
      throw new Error("tsquery stop placeholder survived cleanup");
    case "not":
      return { kind: "not", arg: freeze(node.arg, ids) };
    case "phrase":
      return { kind: "phrase", left: freeze(node.left, ids), right: freeze(node.right, ids), distance: node.distance };
    default:
      return { kind: node.kind, left: freeze(node.left, ids), right: freeze(node.right, ids) };
  }
}

/** websearch_to_tsquery('simple', query); null is the empty query, which matches nothing. */
export function websearchToTsquery(query: string): TsQuery | null {
  const draft = parseWebsearch(query);
  if (draft === null) return null;
  const cleaned = removeStops(draft).node;
  return cleaned === null ? null : freeze(cleaned, { next: 0 });
}

/** tsquery text output (tsquery.c infix()). */
export function formatTsquery(query: TsQuery | null): string {
  if (query === null) return "";
  const render = (node: TsQuery, parentPriority: number, rightPhrase: boolean): string => {
    if (node.kind === "val") return quoteLexeme(node.lexeme);
    if (node.kind === "not") {
      const inner = `!${render(node.arg, PRIORITY.not, false)}`;
      return PRIORITY.not < parentPriority ? `( ${inner} )` : inner;
    }
    const priority = PRIORITY[node.kind];
    const right = render(node.right, priority, node.kind === "phrase");
    const left = render(node.left, priority, false);
    const op =
      node.kind !== "phrase" ? (node.kind === "or" ? "|" : "&") : node.distance === 1 ? "<->" : `<${node.distance}>`;
    const text = `${left} ${op} ${right}`;
    return priority < parentPriority || (node.kind === "phrase" && rightPhrase) ? `( ${text} )` : text;
  };
  return render(query, -1, false);
}

// ---------------------------------------------------------------------------
// @@ and ts_rank_cd
// ---------------------------------------------------------------------------

/** ExecPhraseData: match positions, width, and whether they are negated. */
interface PhraseData {
  pos: number[];
  width: number;
  negate: boolean;
}

/** Positions of an operand, or null when it does not occur (TS_NO). */
type Operand = (node: Extract<TsQuery, { kind: "val" }>) => readonly number[] | null;

const TSPO_L_ONLY = 1;
const TSPO_R_ONLY = 2;
const TSPO_BOTH = 4;

/** TS_phrase_output(): merge two position lists. */
function phraseOutput(data: PhraseData | null, l: PhraseData, r: PhraseData, emit: number, lOffset: number, rOffset: number): boolean {
  let li = 0;
  let ri = 0;
  let any = false;
  while (li < l.pos.length || ri < r.pos.length) {
    let lpos: number;
    let rpos: number;
    let output = 0;
    if (li < l.pos.length) lpos = (l.pos[li] ?? 0) + lOffset;
    else {
      if (!(emit & TSPO_R_ONLY)) break;
      lpos = Number.MAX_SAFE_INTEGER;
    }
    if (ri < r.pos.length) rpos = (r.pos[ri] ?? 0) + rOffset;
    else {
      if (!(emit & TSPO_L_ONLY)) break;
      rpos = Number.MAX_SAFE_INTEGER;
    }
    if (lpos < rpos) {
      if (emit & TSPO_L_ONLY) output = lpos;
      li++;
    } else if (lpos === rpos) {
      if (emit & TSPO_BOTH) output = rpos;
      li++;
      ri++;
    } else {
      if (emit & TSPO_R_ONLY) output = rpos;
      ri++;
    }
    if (output > 0) {
      if (data === null) return true;
      data.pos.push(output);
      any = true;
    }
  }
  return any;
}

function emptyData(): PhraseData {
  return { pos: [], width: 0, negate: false };
}

/** TS_phrase_execute() (no MAYBE results: every operand has positions). */
function phraseExecute(node: TsQuery, operand: Operand, data: PhraseData | null): boolean {
  if (node.kind === "val") {
    const pos = operand(node);
    if (pos === null) return false;
    if (data !== null) data.pos = [...pos];
    return true;
  }
  if (node.kind === "not") {
    const target = data ?? emptyData();
    if (!phraseExecute(node.arg, operand, target)) {
      target.negate = true;
      return true;
    }
    if (target.pos.length > 0) {
      target.negate = !target.negate;
      return true;
    }
    if (target.negate) {
      target.negate = false;
      return false;
    }
    return false;
  }
  const l = emptyData();
  const r = emptyData();
  if (node.kind === "phrase" || node.kind === "and") {
    if (!phraseExecute(node.left, operand, l)) return false;
    if (!phraseExecute(node.right, operand, r)) return false;
    let lOffset: number;
    let rOffset: number;
    if (node.kind === "phrase") {
      lOffset = node.distance + r.width;
      rOffset = 0;
      if (data !== null) data.width = node.distance + l.width + r.width;
    } else {
      const maxWidth = Math.max(l.width, r.width);
      lOffset = maxWidth - l.width;
      rOffset = maxWidth - r.width;
      if (data !== null) data.width = maxWidth;
    }
    if (l.negate && r.negate) {
      phraseOutput(data, l, r, TSPO_BOTH | TSPO_L_ONLY | TSPO_R_ONLY, lOffset, rOffset);
      if (data !== null) data.negate = true;
      return true;
    }
    if (l.negate) return phraseOutput(data, l, r, TSPO_R_ONLY, lOffset, rOffset);
    if (r.negate) return phraseOutput(data, l, r, TSPO_L_ONLY, lOffset, rOffset);
    return phraseOutput(data, l, r, TSPO_BOTH, lOffset, rOffset);
  }
  // OR
  const lmatch = phraseExecute(node.left, operand, l);
  const rmatch = phraseExecute(node.right, operand, r);
  if (!lmatch && !rmatch) return false;
  if (!lmatch) l.width = 0;
  if (!rmatch) r.width = 0;
  const maxWidth = Math.max(l.width, r.width);
  const lOffset = maxWidth - l.width;
  const rOffset = maxWidth - r.width;
  const target = data ?? emptyData();
  target.width = maxWidth;
  if (l.negate && r.negate) {
    phraseOutput(target, l, r, TSPO_BOTH, lOffset, rOffset);
    target.negate = true;
    return true;
  }
  if (l.negate) {
    phraseOutput(target, l, r, TSPO_L_ONLY, lOffset, rOffset);
    target.negate = true;
    return true;
  }
  if (r.negate) {
    phraseOutput(target, l, r, TSPO_R_ONLY, lOffset, rOffset);
    target.negate = true;
    return true;
  }
  return phraseOutput(data, l, r, TSPO_BOTH | TSPO_L_ONLY | TSPO_R_ONLY, lOffset, rOffset);
}

/** TS_execute() with TS_EXEC_EMPTY. */
function execute(node: TsQuery, operand: Operand): boolean {
  switch (node.kind) {
    case "val":
      return operand(node) !== null;
    case "not":
      return !execute(node.arg, operand);
    case "and":
      return execute(node.left, operand) && execute(node.right, operand);
    case "or":
      return execute(node.left, operand) || execute(node.right, operand);
    case "phrase":
      return phraseExecute(node, operand, null);
  }
}

/** `vector @@ query`. */
export function tsMatch(vector: TsVector, query: TsQuery | null): boolean {
  if (query === null) return false;
  return execute(query, (node) => vector.get(node.lexeme) ?? null);
}

function operands(node: TsQuery, out: Extract<TsQuery, { kind: "val" }>[]): void {
  if (node.kind === "val") out.push(node);
  else if (node.kind === "not") operands(node.arg, out);
  else {
    operands(node.left, out);
    operands(node.right, out);
  }
}

/** 1 / weight D (0.1 as float4), as calc_rank_cd() computes invws[0]. */
const INV_WEIGHT_D = 1 / Math.fround(0.1);

/**
 * ts_rank_cd(vector, query) with normalization 0 (tsrank.c calc_rank_cd and
 * Cover), as the float4 PostgreSQL returns.
 */
export function tsRankCd(vector: TsVector, query: TsQuery | null): number {
  if (query === null) return 0;
  const items: Extract<TsQuery, { kind: "val" }>[] = [];
  operands(query, items);
  // get_docrep(): one entry per (position, lexeme), with the operands it satisfies.
  const byKey = new Map<string, { pos: number; lexeme: string; ids: number[] }>();
  for (const item of items) {
    const positions = vector.get(item.lexeme);
    if (positions === undefined) continue;
    for (const pos of positions) {
      const key = `${pos}\u0000${item.lexeme}`;
      const entry = byKey.get(key);
      if (entry === undefined) byKey.set(key, { pos, lexeme: item.lexeme, ids: [item.id] });
      else entry.ids.push(item.id);
    }
  }
  if (byKey.size === 0) return 0;
  const doc = [...byKey.values()].sort((a, b) => a.pos - b.pos || compareBytes(a.lexeme, b.lexeme));
  const len = doc.length;

  // QueryRepresentation: positions seen per operand during a scan.
  let seen = new Map<number, number[]>();
  let reverse = false;
  const fill = (entry: { pos: number; ids: number[] }): void => {
    for (const id of entry.ids) {
      const list = seen.get(id);
      if (list === undefined) seen.set(id, [entry.pos]);
      else if (reverse ? list[0] !== entry.pos : list[list.length - 1] !== entry.pos) {
        if (reverse) list.unshift(entry.pos);
        else list.push(entry.pos);
      }
    }
  };
  const operand: Operand = (node) => seen.get(node.id) ?? null;
  const reset = (rev: boolean): void => {
    seen = new Map();
    reverse = rev;
  };

  let extPos = 0;
  let wdoc = 0;
  /** Cover(): the next minimal extent [begin, end] satisfying the query. */
  const cover = (): { begin: number; end: number; p: number; q: number } | null => {
    for (;;) {
      let lastpos = extPos;
      let found = false;
      reset(false);
      let p = Number.MAX_SAFE_INTEGER;
      let q = 0;
      let end = -1;
      let begin = -1;
      for (let k = extPos; k < len; k++) {
        const entry = doc[k];
        if (entry === undefined) break;
        fill(entry);
        if (execute(query, operand)) {
          if (entry.pos > q) {
            q = entry.pos;
            end = k;
            lastpos = k;
            found = true;
          }
          break;
        }
      }
      if (!found) return null;
      reset(true);
      let k = lastpos;
      for (; k >= extPos; k--) {
        const entry = doc[k];
        if (entry === undefined) break;
        fill(entry);
        if (execute(query, operand)) {
          if (entry.pos < p) {
            begin = k;
            p = entry.pos;
          }
          break;
        }
      }
      if (p <= q) {
        extPos = k + 1;
        return { begin, end, p, q };
      }
      extPos++;
    }
  };
  for (;;) {
    const ext = cover();
    if (ext === null) break;
    let invSum = 0;
    for (let k = ext.begin; k <= ext.end; k++) invSum += INV_WEIGHT_D;
    const cpos = (ext.end - ext.begin + 1) / invSum;
    let noise = ext.q - ext.p - (ext.end - ext.begin);
    if (noise < 0) noise = Math.trunc((ext.end - ext.begin) / 2);
    wdoc += cpos / (1 + noise);
  }
  return float4(wdoc);
}

/** A float4 result as PostgreSQL prints it: the shortest text that reads back as the same float4. */
function float4(x: number): number {
  const f = Math.fround(x);
  if (f === 0 || !Number.isFinite(f)) return f;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(f.toPrecision(digits));
    if (Math.fround(candidate) === f) return candidate;
  }
  return f;
}

// ---------------------------------------------------------------------------
// SQL entry points
// ---------------------------------------------------------------------------

const queryCache = new Map<string, TsQuery | null>();

function cachedQuery(query: string): TsQuery | null {
  if (queryCache.has(query)) return queryCache.get(query) ?? null;
  const parsed = websearchToTsquery(query);
  if (queryCache.size > 500) queryCache.clear();
  queryCache.set(query, parsed);
  return parsed;
}

/** `to_tsvector('simple', document) @@ websearch_to_tsquery('simple', query)`. */
export function ftsMatch(document: string, query: string): boolean {
  const q = cachedQuery(query);
  return q !== null && tsMatch(toTsvector(document), q);
}

/** `ts_rank_cd(to_tsvector('simple', document), websearch_to_tsquery('simple', query))`. */
export function ftsRank(document: string, query: string): number {
  const q = cachedQuery(query);
  return q === null ? 0 : tsRankCd(toTsvector(document), q);
}
