/**
 * Explicit category → Belgian deduction-type classifier.
 *
 * Vision categories are USER-DEFINED free text stored as `general` + `detail`
 * (joined as "GENERAL:DETAIL" over the API), so a fixed category-id → deduction
 * table is impossible. This module is instead a curated, best-effort mapping
 * over category NAME tokens. It replaces the old keyword-substring heuristic in
 * the getDeductibles AI-chat tool, which over-matched badly (e.g. INSURANCE:CAR
 * — not deductible — matched the same as INSURANCE:LIFE) and lumped everything
 * into one flat "deductible" bucket.
 *
 * Design rules:
 *   - Matching is on whole word tokens (and multi-word token phrases), never
 *     naive substring-of-substring, and is case- and diacritic-insensitive.
 *   - Bilingual: English + Dutch keywords, since the app is bilingual.
 *   - PRECISION over recall: it is better to return null (a miss the user can
 *     add manually) than to misclassify (a false positive that would feed a
 *     tax pre-fill later). Ambiguous words therefore do NOT match: bare "GIFT"
 *     (birthday gifts), bare "MAINTENANCE" (home/car maintenance), bare
 *     "UNION" (credit union), bare "MORTGAGE" (capital repayment is not the
 *     interest deduction), bare "INSURANCE" (car/home insurance).
 *   - Deliberately NOT classified as deductible: generic INSURANCE, MEDICAL /
 *     health, TAX, TUITION. The old heuristic matched all of these, but under
 *     Belgian tax law medical costs and tuition are generally not simple
 *     deductions, "tax" spending is not itself deductible, and only specific
 *     insurance products (life / group) qualify — so returning null is the
 *     safer, more-correct behavior.
 *
 * The keys in DEDUCTION_TYPES are a stable contract: a frontend task maps them
 * to BelgianTaxProfile fields. Do not rename them.
 */

/** Stable deduction-type keys modeled by the Belgian tax calculator. */
export const DEDUCTION_TYPES = Object.freeze([
  'pensionSavings',
  'lifeInsurance',
  'groupInsurance',
  'charitableDonations',
  'childcare',
  'alimony',
  'unionDues',
  'mortgageInterest',
]);

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Split a category part into uppercase word tokens.
 * Diacritics are stripped first so CRÈCHE tokenizes as CRECHE.
 *
 * @param {string|null|undefined} value
 * @returns {string[]}
 */
function tokenize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Tokenized category parts a rule tests against: `all` is general + detail
 * concatenated.
 *
 * @typedef {{ general: string[], detail: string[], all: string[] }} CategoryTokens
 */

/**
 * True when any token in `tokens` is exactly one of `words`.
 *
 * @param {string[]} tokens
 * @param {readonly string[]} words
 * @returns {boolean}
 */
function hasWord(tokens, words) {
  return tokens.some((t) => words.includes(t));
}

/**
 * True when `phrase` (an array of words) appears as consecutive tokens.
 *
 * @param {string[]} tokens
 * @param {readonly string[]} phrase
 * @returns {boolean}
 */
function hasPhrase(tokens, phrase) {
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Phrase lookup within EITHER the general or the detail part (phrases do not
 * span the general/detail boundary — that boundary is a deliberate split the
 * user made, not adjacent words).
 *
 * @param {CategoryTokens} cat
 * @param {readonly (readonly string[])[]} phrases
 * @returns {boolean}
 */
function hasAnyPhrase(cat, phrases) {
  return phrases.some((p) => hasPhrase(cat.general, p) || hasPhrase(cat.detail, p));
}

// ---------------------------------------------------------------------------
// Curated keyword sets (auditable — every match traces back to one of these)
// ---------------------------------------------------------------------------

// Insurance context words. Presence alone NEVER classifies — a qualifying
// product word (life / group) is also required.
const INSURANCE_WORDS = Object.freeze(['INSURANCE', 'VERZEKERING', 'VERZEKERINGEN']);

const PENSION_WORDS = Object.freeze(['PENSION', 'PENSIOEN', 'PENSIOENSPAREN', 'RETIREMENT']);
const PENSION_PHRASES = Object.freeze([['PENSION', 'SAVING'], ['PENSION', 'SAVINGS']]);

const LIFE_WORDS = Object.freeze(['LIFE', 'LEVEN']);
// Compound Dutch word that is self-sufficient (product + insurance in one token).
const LIFE_INSURANCE_WORDS = Object.freeze(['LEVENSVERZEKERING', 'LEVENSVERZEKERINGEN']);

const GROUP_WORDS = Object.freeze(['GROUP', 'GROEP']);
const GROUP_INSURANCE_WORDS = Object.freeze(['GROEPSVERZEKERING', 'GROEPSVERZEKERINGEN']);

// Charity: unambiguous donation/charity wording only. Bare GIFT/GIFTS is NOT
// here — "GIFTS:BIRTHDAY" is a present, not a donation. Dutch "GIFTEN" (the
// fiscal term for charitable gifts) IS unambiguous and included.
const CHARITY_WORDS = Object.freeze([
  'DONATION', 'DONATIONS', 'DONATIE', 'DONATIES',
  'CHARITY', 'CHARITIES', 'LIEFDADIGHEID',
  'SCHENKING', 'SCHENKINGEN', 'GIFTEN',
]);
const CHARITY_PHRASES = Object.freeze([
  ['GOEDE', 'DOEL'], ['GOEDE', 'DOELEN'], ['CHARITABLE', 'GIFT'], ['CHARITABLE', 'GIFTS'],
]);

const CHILDCARE_WORDS = Object.freeze([
  'CHILDCARE', 'DAYCARE', 'KINDEROPVANG', 'CRECHE', 'KINDERDAGVERBLIJF',
]);
const CHILDCARE_PHRASES = Object.freeze([['CHILD', 'CARE'], ['DAY', 'CARE']]);

// Bare MAINTENANCE deliberately excluded (home/car maintenance); only the
// explicitly spousal phrase qualifies alongside the unambiguous words.
const ALIMONY_WORDS = Object.freeze(['ALIMONY', 'ONDERHOUDSGELD', 'ALIMENTATIE']);
const ALIMONY_PHRASES = Object.freeze([['SPOUSAL', 'MAINTENANCE']]);

// Bare UNION deliberately excluded (credit union, etc.).
const UNION_WORDS = Object.freeze(['VAKBOND', 'VAKBONDSBIJDRAGE', 'VAKBONDSBIJDRAGEN']);
const UNION_PHRASES = Object.freeze([['UNION', 'DUES'], ['TRADE', 'UNION']]);

const MORTGAGE_WORDS = Object.freeze(['MORTGAGE', 'HYPOTHEEK']);
const INTEREST_WORDS = Object.freeze(['INTEREST', 'RENTE', 'INTREST', 'INTRESTEN']);
// Compound Dutch word that is self-sufficient.
const MORTGAGE_INTEREST_WORDS = Object.freeze(['HYPOTHEEKRENTE']);

// ---------------------------------------------------------------------------
// Rules — evaluated in order, first match wins
// ---------------------------------------------------------------------------

/**
 * Each rule receives `cat = { general, detail, all }` (token arrays; `all` is
 * general + detail concatenated) and returns a boolean.
 *
 * Ordering notes:
 *   - groupInsurance is checked BEFORE lifeInsurance so an employer-scheme
 *     name like "GROUP LIFE INSURANCE" lands in the more specific
 *     groupInsurance (2nd pillar), not lifeInsurance.
 *
 * @type {ReadonlyArray<{ type: string, test: (cat: CategoryTokens) => boolean }>}
 */
const RULES = Object.freeze([
  {
    // PENSION / PENSIOEN / PENSIOENSPAREN / RETIREMENT / "pension saving(s)"
    type: 'pensionSavings',
    test: (cat) => hasWord(cat.all, PENSION_WORDS) || hasAnyPhrase(cat, PENSION_PHRASES),
  },
  {
    // GROEPSVERZEKERING, or insurance context + GROUP/GROEP.
    type: 'groupInsurance',
    test: (cat) =>
      hasWord(cat.all, GROUP_INSURANCE_WORDS) ||
      (hasWord(cat.all, INSURANCE_WORDS) && hasWord(cat.all, GROUP_WORDS)),
  },
  {
    // LEVENSVERZEKERING, or insurance context + LIFE/LEVEN. Generic INSURANCE
    // or CAR/HOME/AUTO/WONING insurance has no life word → falls through to null.
    type: 'lifeInsurance',
    test: (cat) =>
      hasWord(cat.all, LIFE_INSURANCE_WORDS) ||
      (hasWord(cat.all, INSURANCE_WORDS) && hasWord(cat.all, LIFE_WORDS)),
  },
  {
    // Donation/charity wording only; ambiguous bare "gift" leans null.
    type: 'charitableDonations',
    test: (cat) => hasWord(cat.all, CHARITY_WORDS) || hasAnyPhrase(cat, CHARITY_PHRASES),
  },
  {
    type: 'childcare',
    test: (cat) => hasWord(cat.all, CHILDCARE_WORDS) || hasAnyPhrase(cat, CHILDCARE_PHRASES),
  },
  {
    type: 'alimony',
    test: (cat) => hasWord(cat.all, ALIMONY_WORDS) || hasAnyPhrase(cat, ALIMONY_PHRASES),
  },
  {
    type: 'unionDues',
    test: (cat) => hasWord(cat.all, UNION_WORDS) || hasAnyPhrase(cat, UNION_PHRASES),
  },
  {
    // HYPOTHEEKRENTE, or mortgage word + interest word (possibly split across
    // general/detail, e.g. MORTGAGE:INTEREST or HYPOTHEEK:RENTE). Plain
    // MORTGAGE without an interest word is capital repayment → conservative null.
    type: 'mortgageInterest',
    test: (cat) =>
      hasWord(cat.all, MORTGAGE_INTEREST_WORDS) ||
      (hasWord(cat.all, MORTGAGE_WORDS) && hasWord(cat.all, INTEREST_WORDS)),
  },
]);

/**
 * Classify a user-defined category into a Belgian deduction type.
 *
 * @param {string|null|undefined} general - category general part
 * @param {string|null|undefined} detail - category detail part
 * @returns {string|null} one of DEDUCTION_TYPES, or null when the category is
 *   not a recognized deductible (the safe default).
 */
export function classifyDeduction(general, detail) {
  const generalTokens = tokenize(general);
  const detailTokens = tokenize(detail);
  if (generalTokens.length === 0 && detailTokens.length === 0) return null;

  const cat = {
    general: generalTokens,
    detail: detailTokens,
    all: [...generalTokens, ...detailTokens],
  };

  for (const rule of RULES) {
    if (rule.test(cat)) return rule.type;
  }
  return null;
}
