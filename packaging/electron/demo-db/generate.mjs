// Deterministic generator for the Vision demo dataset. Emits data-only SQL for
// a database that has already been migrated to the packaged schema revision.
// Persona: a Belgian dual-income household in Ghent, ~2.5 years of history.

import { pathToFileURL } from "node:url";

// ---- deterministic PRNG (mulberry32, fixed seed) ----
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260618);
const ri = (lo, hi) => Math.floor(rand() * (hi - lo + 1)) + lo;
const rf = (lo, hi) => rand() * (hi - lo) + lo;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

// ---- date helpers (UTC) ----
const fmt = (dt) => dt.toISOString().slice(0, 10);
const rawYmd = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const ANCHOR_DATE = rawYmd(2026, 6, 18);
const requestedReferenceDate = new URL(import.meta.url).searchParams.get(
  "referenceDate",
);
const referenceDateText =
  requestedReferenceDate || new Date().toISOString().slice(0, 10);
const REFERENCE_DATE = new Date(`${referenceDateText}T00:00:00.000Z`);
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(referenceDateText) ||
  Number.isNaN(REFERENCE_DATE.getTime()) ||
  fmt(REFERENCE_DATE) !== referenceDateText
) {
  throw new Error("Demo referenceDate must be an ISO calendar date");
}
const SHIFT_DAYS = Math.round(
  (REFERENCE_DATE.getTime() - ANCHOR_DATE.getTime()) / 86400000,
);
const ymd = (y, m, d) =>
  new Date(Date.UTC(y, m - 1, d) + SHIFT_DAYS * 86400000);
const addDaysUTC = (dt, n) => new Date(dt.getTime() + n * 86400000);
const daysInMonth = (y, m) => rawYmd(y, m + 1, 0).getUTCDate();
const TODAY = ymd(2026, 6, 18);
const HOLIDAY_TAG = `holiday-${ymd(2025, 7, 1).getUTCFullYear()}`;
const nlMonths = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
];

// ---- SQL emission ----
const out = [];
const S = (s) => out.push(s);
const q = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const num = (v, d = 2) =>
  v === null || v === undefined ? "NULL" : Number(v).toFixed(d);
S("-- Vision demo data (synthetic). Generated deterministically.");

// ---- Accounts (ADR-088: real account entities) ----
// `bank_account` strings double as the account `name`: the dual-write trigger (migration 0051)
// links each transaction to the account whose name == btrim(bank_account), and its
// ON CONFLICT(name) DO NOTHING leaves the rich typed rows we pre-create here untouched.
const ACCT = {
  CHECKING: "BE76 7340 1234 5678",
  SAVINGS: "BE12 0688 1947 5532",
  MORTGAGE: "KBC Woonkrediet",
};
const START_BAL = {
  [ACCT.CHECKING]: 4200,
  [ACCT.SAVINGS]: 8000,
  [ACCT.MORTGAGE]: -205000,
};
// Stable account ids — referenced by portfolio holdings for per-account positioning (ADR-091).
// Brokerage/exchange accounts (3,4,6) are linked to lots by id, not via a bank_account string.
const AID = {
  CHECKING: 1,
  SAVINGS: 2,
  DEGIRO: 3,
  IBKR: 4,
  MORTGAGE: 5,
  BITVAVO: 6,
};

// Mortgage on the owned home (bought 2018 -> Flemish woonbonus eligible).
const MORTGAGE = {
  principal: 220000,
  annual: 2.0,
  termM: 300,
  start: ymd(2018, 5, 1),
};
const _mr = MORTGAGE.annual / 12 / 100;
const MORTGAGE_PAY =
  (MORTGAGE.principal * _mr) / (1 - Math.pow(1 + _mr, -MORTGAGE.termM)); // ~932.6/mo

// ===== Categories =====
const CATS = [
  ["INCOME", "SALARY"],
  ["INCOME", "BONUS"],
  ["INCOME", "REFUND"],
  ["INCOME", "INTEREST"],
  ["INCOME", "GIFT"],
  ["HOUSING", "RENT"],
  ["HOUSING", "MORTGAGE"],
  ["HOUSING", "UTILITIES"],
  ["HOUSING", "INTERNET"],
  ["HOUSING", "INSURANCE"],
  ["FOOD", "GROCERIES"],
  ["FOOD", "RESTAURANT"],
  ["FOOD", "TAKEAWAY"],
  ["FOOD", "COFFEE"],
  ["TRANSPORT", "FUEL"],
  ["TRANSPORT", "PUBLIC"],
  ["TRANSPORT", "CAR"],
  ["TRANSPORT", "PARKING"],
  ["HEALTH", "PHARMACY"],
  ["HEALTH", "DOCTOR"],
  ["HEALTH", "INSURANCE"],
  ["LEISURE", "STREAMING"],
  ["LEISURE", "SPORT"],
  ["LEISURE", "HOBBIES"],
  ["LEISURE", "TRAVEL"],
  ["SHOPPING", "CLOTHING"],
  ["SHOPPING", "ELECTRONICS"],
  ["SHOPPING", "HOME"],
  ["FINANCE", "SAVINGS"],
  ["FINANCE", "INVESTMENT"],
  ["FINANCE", "FEES"],
  ["FINANCE", "TAX"],
  ["TELECOM", "MOBILE"],
];
const catId = {};
CATS.forEach((c, i) => {
  const id = i + 1;
  catId[c[0] + ":" + c[1]] = id;
  S(
    `INSERT INTO categories (id,general,detail,is_active) VALUES (${id},${q(c[0])},${q(c[1])},true);`,
  );
});

// ===== Recipients =====
const RECIPS = [
  ["Tech Solutions BVBA", "INCOME:SALARY"],
  ["Creatief Bureau BVBA", "INCOME:SALARY"],
  ["Freelance Klant Vander", "INCOME:BONUS"],
  ["Engie Electrabel", "HOUSING:UTILITIES"],
  ["Farys", "HOUSING:UTILITIES"],
  ["Telenet", "HOUSING:INTERNET"],
  ["Proximus", "TELECOM:MOBILE"],
  ["Netflix", "LEISURE:STREAMING"],
  ["Spotify", "LEISURE:STREAMING"],
  ["Disney Plus", "LEISURE:STREAMING"],
  ["Basic-Fit", "LEISURE:SPORT"],
  ["AG Insurance", "HOUSING:INSURANCE"],
  ["DKV Belgium", "HEALTH:INSURANCE"],
  ["De Lijn", "TRANSPORT:PUBLIC"],
  ["NMBS", "TRANSPORT:PUBLIC"],
  ["DEGIRO", "FINANCE:INVESTMENT"],
  ["KBC Bank", "INCOME:INTEREST"],
  ["FOD Financien", "FINANCE:TAX"],
  ["Eigen Spaarrekening", "FINANCE:SAVINGS"],
  ["Onbekende Begunstigde", ""],
  ["Colruyt", "FOOD:GROCERIES"],
  ["Delhaize", "FOOD:GROCERIES"],
  ["Carrefour", "FOOD:GROCERIES"],
  ["Albert Heijn", "FOOD:GROCERIES"],
  ["Aldi", "FOOD:GROCERIES"],
  ["Lidl", "FOOD:GROCERIES"],
  ["Q8", "TRANSPORT:FUEL"],
  ["Total", "TRANSPORT:FUEL"],
  ["Shell", "TRANSPORT:FUEL"],
  ["Restaurant De Vis", "FOOD:RESTAURANT"],
  ["Pizza Napoli", "FOOD:RESTAURANT"],
  ["Brasserie Central", "FOOD:RESTAURANT"],
  ["Starbucks", "FOOD:COFFEE"],
  ["Bar Mocca", "FOOD:COFFEE"],
  ["Bolt Food", "FOOD:TAKEAWAY"],
  ["Deliveroo", "FOOD:TAKEAWAY"],
  ["Apotheek Centrum", "HEALTH:PHARMACY"],
  ["Dr. Janssens", "HEALTH:DOCTOR"],
  ["Parking Gent", "TRANSPORT:PARKING"],
  ["Bol.com", "SHOPPING:ELECTRONICS"],
  ["Coolblue", "SHOPPING:ELECTRONICS"],
  ["MediaMarkt", "SHOPPING:ELECTRONICS"],
  ["Zalando", "SHOPPING:CLOTHING"],
  ["H&M", "SHOPPING:CLOTHING"],
  ["IKEA", "SHOPPING:HOME"],
  ["Booking.com", "LEISURE:TRAVEL"],
  ["Brussels Airlines", "LEISURE:TRAVEL"],
  ["Decathlon", "LEISURE:HOBBIES"],
  ["Standaard Boekhandel", "LEISURE:HOBBIES"],
  ["Thomas Peeters", "FOOD:RESTAURANT"],
  ["Sarah Maes", "FOOD:RESTAURANT"],
  ["Lukas De Smet", "LEISURE:TRAVEL"],
  ["KBC Woonkrediet", "HOUSING:MORTGAGE"],
];
const recId = {};
RECIPS.forEach((r, i) => {
  const id = i + 1;
  recId[r[0]] = id;
  const norm = r[0]
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  S(
    `INSERT INTO recipients (id,name,normalized_name,default_category_id,is_active) VALUES (${id},${q(r[0])},${q(norm)},${catId[r[1]] || "NULL"},true);`,
  );
});

S(
  `INSERT INTO recipient_bank_accounts (id,recipient_id,account_number,bank_name,is_primary,is_active) VALUES (1,${recId["Creatief Bureau BVBA"]},'BE68 5390 0754 7034','KBC',true,true);`,
);
S(
  `INSERT INTO recipient_bank_accounts (id,recipient_id,account_number,bank_name,is_primary,is_active) VALUES (2,${recId["Tech Solutions BVBA"]},'BE71 0961 2345 6769','BNP Paribas Fortis',true,true);`,
);
S(
  `INSERT INTO recipient_bank_accounts (id,recipient_id,account_number,bank_name,is_primary,is_active) VALUES (3,${recId["KBC Woonkrediet"]},'BE62 5100 0754 7061','KBC',true,true);`,
);
S(
  `INSERT INTO recipient_match_patterns (id,recipient_id,pattern,pattern_kind,priority) VALUES (1,${recId["Colruyt"]},'COLRUYT','literal_prefix',10);`,
);
S(
  `INSERT INTO recipient_match_patterns (id,recipient_id,pattern,pattern_kind,priority) VALUES (2,${recId["Tech Solutions BVBA"]},'SALARIS TECH SOLUTIONS','literal_prefix',10);`,
);

const groceries = [
  "Colruyt",
  "Delhaize",
  "Carrefour",
  "Albert Heijn",
  "Aldi",
  "Lidl",
];
const fuels = ["Q8", "Total", "Shell"];
const restaurants = ["Restaurant De Vis", "Pizza Napoli", "Brasserie Central"];
const coffees = ["Starbucks", "Bar Mocca"];
const takeaways = ["Bolt Food", "Deliveroo"];
const clothing = ["Zalando", "H&M"];
const electronics = ["Bol.com", "Coolblue", "MediaMarkt"];
const travel = ["Booking.com", "Brussels Airlines"];
const hobbies = ["Decathlon", "Standaard Boekhandel"];

// ===== Transactions (collected, then balance-stamped + emitted) =====
let txId = 0;
const txns = [];
const tagLinks = [];
const splitCands = [];
function tx(
  date,
  amount,
  recip,
  catKey,
  memo,
  comment = null,
  account = ACCT.CHECKING,
  opts = {},
) {
  txId++;
  const cid = catKey ? (catId[catKey] ?? null) : null;
  txns.push({
    id: txId,
    date,
    amount,
    recip,
    cid,
    memo,
    comment,
    account,
    isTransfer: opts.isTransfer || false,
    transferSource: opts.transferSource || null,
  });
  return txId;
}
function on(y, m, day, fn) {
  const md = daysInMonth(y, m);
  let d = Math.min(day, md);
  const dt = ymd(y, m, d);
  if (dt <= TODAY) fn(dt);
}

for (let y = 2024; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 6) break;
    const md = y === 2026 && m === 6 ? 17 : daysInMonth(y, m);
    const mn = nlMonths[m - 1];
    // income
    const raise = (y - 2024) * 0.03;
    const salary = 3400 * (1 + raise) + ri(-20, 20);
    on(y, m, 25, (d) =>
      tx(d, salary, "Tech Solutions BVBA", "INCOME:SALARY", `Loon ${mn} ${y}`),
    );
    // partner's (part-time) salary on a different day -> two income bumps, smoother cash flow
    const psal = 1400 * (1 + raise) + ri(-15, 15);
    on(y, m, 5, (d) =>
      tx(
        d,
        psal,
        "Creatief Bureau BVBA",
        "INCOME:SALARY",
        `Loon partner ${mn} ${y}`,
      ),
    );
    if (m === 12)
      on(y, m, 20, (d) =>
        tx(
          d,
          1500,
          "Tech Solutions BVBA",
          "INCOME:BONUS",
          `Eindejaarsbonus ${y}`,
        ),
      );
    if (chance(0.25))
      on(y, m, ri(10, 20), (d) => {
        const t = tx(
          d,
          rf(300, 900),
          "Freelance Klant Vander",
          "INCOME:BONUS",
          "Freelance opdracht",
        );
        tagLinks.push({ txId: t, slug: "work" });
      });
    // savings interest (paid into the savings account, quarterly)
    if (m % 3 === 1)
      on(y, m, 2, (d) =>
        tx(
          d,
          rf(8, 30),
          "KBC Bank",
          "INCOME:INTEREST",
          "Rente spaarrekening",
          null,
          ACCT.SAVINGS,
        ),
      );
    // monthly transfer checking -> savings (a paired transfer)
    on(y, m, 28, (d) => {
      tx(
        d,
        -1100,
        "Eigen Spaarrekening",
        "FINANCE:SAVINGS",
        "Overschrijving naar spaarrekening",
      );
      tx(
        d,
        1100,
        "Eigen Spaarrekening",
        "FINANCE:SAVINGS",
        "Storting van zichtrekening",
        null,
        ACCT.SAVINGS,
      );
    });
    // housing / fixed
    on(y, m, 3, (d) =>
      tx(
        d,
        -MORTGAGE_PAY,
        "KBC Woonkrediet",
        "HOUSING:MORTGAGE",
        `Hypotheek aflossing ${mn}`,
      ),
    );
    on(y, m, 8 + ri(0, 3), (d) =>
      tx(
        d,
        -rf(85, 150),
        "Engie Electrabel",
        "HOUSING:UTILITIES",
        "Energievoorschot",
      ),
    );
    if (m % 3 === 2)
      on(y, m, 15, (d) =>
        tx(d, -rf(40, 75), "Farys", "HOUSING:UTILITIES", "Waterfactuur"),
      );
    on(y, m, 12, (d) => {
      const t = tx(d, -54.0, "Telenet", "HOUSING:INTERNET", "Internet + TV");
      tagLinks.push({ txId: t, slug: "subscription" });
    });
    on(y, m, 12, (d) => {
      const t = tx(d, -22.0, "Proximus", "TELECOM:MOBILE", "GSM abonnement");
      tagLinks.push({ txId: t, slug: "subscription" });
    });
    on(y, m, 6, (d) =>
      tx(
        d,
        -45.0,
        "AG Insurance",
        "HOUSING:INSURANCE",
        "Brand/familiale verzekering",
      ),
    );
    on(y, m, 6, (d) => {
      const t = tx(
        d,
        -38.0,
        "DKV Belgium",
        "HEALTH:INSURANCE",
        "Hospitalisatieverzekering",
      );
      tagLinks.push({ txId: t, slug: "tax-deductible" });
    });
    // subscriptions
    on(y, m, 18, (d) => {
      const t = tx(
        d,
        -13.99,
        "Netflix",
        "LEISURE:STREAMING",
        "Netflix abonnement",
      );
      tagLinks.push({ txId: t, slug: "subscription" });
    });
    on(y, m, 5, (d) => {
      const t = tx(
        d,
        -10.99,
        "Spotify",
        "LEISURE:STREAMING",
        "Spotify Premium",
      );
      tagLinks.push({ txId: t, slug: "subscription" });
    });
    if (y >= 2025)
      on(y, m, 5, (d) => {
        const t = tx(
          d,
          -8.99,
          "Disney Plus",
          "LEISURE:STREAMING",
          "Disney+ abonnement",
        );
        tagLinks.push({ txId: t, slug: "subscription" });
      });
    on(y, m, 2, (d) => {
      const t = tx(
        d,
        -29.99,
        "Basic-Fit",
        "LEISURE:SPORT",
        "Fitness abonnement",
      );
      tagLinks.push({ txId: t, slug: "subscription" });
    });
    on(y, m, 3, (d) =>
      tx(d, -49.0, "De Lijn", "TRANSPORT:PUBLIC", "Buzzy Pazz abonnement"),
    );
    if (chance(0.3))
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(12, 45), "NMBS", "TRANSPORT:PUBLIC", "Treinticket"),
      );
    // investing transfer (mirrors DCA) — after payday so it doesn't deepen the mid-month trough
    on(y, m, 27, (d) =>
      tx(d, -750, "DEGIRO", "FINANCE:INVESTMENT", "Belegging storting"),
    );
    // groceries 4-5x
    for (let i = 0; i < ri(4, 5); i++)
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(32, 128), pick(groceries), "FOOD:GROCERIES", "Boodschappen"),
      );
    // fuel ~2x
    for (let i = 0; i < ri(1, 2); i++)
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(48, 86), pick(fuels), "TRANSPORT:FUEL", "Tankbeurt"),
      );
    // restaurants 2-4x (split candidates)
    for (let i = 0; i < ri(2, 4); i++)
      on(y, m, ri(1, md), (d) => {
        const a = -rf(26, 95);
        const t = tx(d, a, pick(restaurants), "FOOD:RESTAURANT", "Restaurant");
        if (Math.abs(a) > 45)
          splitCands.push({ txId: t, amount: Math.abs(a), date: d });
      });
    // coffee 3-6x
    for (let i = 0; i < ri(3, 6); i++)
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(3.2, 7.5), pick(coffees), "FOOD:COFFEE", "Koffie"),
      );
    // takeaway 1-3x
    for (let i = 0; i < ri(1, 3); i++)
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(15, 42), pick(takeaways), "FOOD:TAKEAWAY", "Afhaalmaaltijd"),
      );
    // shopping 0-2x
    for (let i = 0; i < ri(0, 2); i++)
      on(y, m, ri(1, md), (d) => {
        const r = rand();
        if (r < 0.4) {
          tx(d, -rf(30, 180), pick(clothing), "SHOPPING:CLOTHING", "Kleding");
        } else if (r < 0.75) {
          const t = tx(
            d,
            -rf(40, 650),
            pick(electronics),
            "SHOPPING:ELECTRONICS",
            "Electronica",
          );
          if (chance(0.3)) tagLinks.push({ txId: t, slug: "work" });
        } else {
          tx(d, -rf(35, 400), "IKEA", "SHOPPING:HOME", "Woninginrichting");
        }
      });
    // health occasional
    if (chance(0.6))
      on(y, m, ri(1, md), (d) => {
        const t = tx(
          d,
          -rf(8, 46),
          "Apotheek Centrum",
          "HEALTH:PHARMACY",
          "Apotheek",
        );
        tagLinks.push({ txId: t, slug: "tax-deductible" });
      });
    if (chance(0.25))
      on(y, m, ri(1, md), (d) => {
        const t = tx(
          d,
          -rf(30, 65),
          "Dr. Janssens",
          "HEALTH:DOCTOR",
          "Consultatie huisarts",
        );
        tagLinks.push({ txId: t, slug: "tax-deductible" });
      });
    // parking / hobbies
    if (chance(0.5))
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(2, 16), "Parking Gent", "TRANSPORT:PARKING", "Parking"),
      );
    if (chance(0.35))
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(15, 90), pick(hobbies), "LEISURE:HOBBIES", "Hobby"),
      );
    // a few uncategorised payments (for the categorisation demo)
    if (chance(0.4))
      on(y, m, ri(1, md), (d) =>
        tx(d, -rf(12, 90), "Onbekende Begunstigde", null, "Onbekende betaling"),
      );
    // summer travel (holiday-2025 tag)
    if (m >= 6 && m <= 8 && chance(0.7)) {
      on(y, m, ri(1, md), (d) => {
        const a = -rf(180, 900);
        const t = tx(d, a, pick(travel), "LEISURE:TRAVEL", "Reis / vakantie");
        if (y === 2025) tagLinks.push({ txId: t, slug: HOLIDAY_TAG });
        splitCands.push({ txId: t, amount: Math.abs(a), date: d });
      });
    }
    // yearly tax in October
    if (m === 10)
      on(y, m, 15, (d) =>
        tx(
          d,
          -rf(900, 1400),
          "FOD Financien",
          "FINANCE:TAX",
          "Personenbelasting afrekening",
        ),
      );
    if (m === 6 && chance(0.5))
      on(y, m, 30, (d) =>
        tx(
          d,
          rf(150, 600),
          "FOD Financien",
          "INCOME:REFUND",
          "Belastingteruggave",
        ),
      );
  }
}

// ===== Liability ledger (ADR-092: liabilities as negative accounts) =====
// The mortgage is its own account (type=liability), surfacing in net worth as a negative
// balance. Quarterly principal-paydown entries lift the balance from -205 000 toward ~-185 250.
// Marked is_transfer so they never inflate income/spending (the cash leg is the monthly
// mortgage payment already on the checking account).
for (let y = 2024; y <= 2026; y++) {
  for (let m = 1; m <= 12; m += 3) {
    if (y === 2026 && m > 6) break;
    on(y, m, 1, (d) =>
      tx(
        d,
        1975,
        "KBC Woonkrediet",
        "HOUSING:MORTGAGE",
        "Kapitaalaflossing hypotheek",
        null,
        ACCT.MORTGAGE,
        { isTransfer: true, transferSource: "manual" },
      ),
    );
  }
}

// running balance per account, then emit
const byAcct = {};
for (const t of txns) {
  (byAcct[t.account] = byAcct[t.account] || []).push(t);
}
for (const acct of Object.keys(byAcct)) {
  const list = byAcct[acct].sort((a, b) => a.date - b.date || a.id - b.id);
  let bal = START_BAL[acct] || 0;
  for (const t of list) {
    bal += t.amount;
    t.balance = bal;
  }
}

// ===== Accounts (typed entities) — emitted before the transaction rows so the dual-write
// trigger (0051) resolves each transaction's account_id onto these rich rows. statement_balance
// drives the reconciliation-drift feature (ADR-094): checking drifts +€15.50, savings reconciles.
const finalBal = (a) => {
  const l = byAcct[a];
  return l && l.length ? l[l.length - 1].balance : 0;
};
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,statement_balance,statement_balance_date) VALUES (${AID.CHECKING},${q(ACCT.CHECKING)},'KBC Zichtrekening','KBC','checking','liquid','joint','EUR',${num(finalBal(ACCT.CHECKING) + 15.5, 2)},'${fmt(TODAY)}');`,
);
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,statement_balance,statement_balance_date) VALUES (${AID.SAVINGS},${q(ACCT.SAVINGS)},'KBC Spaarrekening','KBC','savings','semi_liquid','joint','EUR',${num(finalBal(ACCT.SAVINGS), 2)},'${fmt(TODAY)}');`,
);
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,has_cash_sleeve) VALUES (${AID.DEGIRO},'DEGIRO Beleggingsrekening','DEGIRO','DEGIRO','brokerage','liquid','me','EUR',true);`,
);
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,has_cash_sleeve) VALUES (${AID.IBKR},'Interactive Brokers','IBKR','Interactive Brokers','brokerage','liquid','partner','EUR',true);`,
);
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,spendable,has_cash_sleeve) VALUES (${AID.MORTGAGE},${q(ACCT.MORTGAGE)},'Hypotheek woning Gent','KBC','liability','illiquid','joint','EUR',false,false);`,
);
S(
  `INSERT INTO accounts (id,name,display_name,institution,type,liquidity_class,owner,currency,has_cash_sleeve) VALUES (${AID.BITVAVO},'Bitvavo','Bitvavo','Bitvavo','crypto_exchange','liquid','me','EUR',true);`,
);

for (const t of txns.slice().sort((a, b) => a.id - b.id)) {
  S(
    `INSERT INTO transactions (id,date,amount,currency,bank_account,recipient_id,category_id,is_active,memo,comment,balance,is_transfer,transfer_source) VALUES (${t.id},'${fmt(t.date)}',${num(t.amount, 4)},'EUR',${q(t.account)},${recId[t.recip]},${t.cid ?? "NULL"},true,${q(t.memo)},${q(t.comment)},${num(t.balance, 2)},${t.isTransfer ? "true" : "false"},${t.transferSource ? q(t.transferSource) : "NULL"});`,
  );
}

// ===== Tags =====
const TAGS = [
  ["subscription", "#6366f1"],
  ["tax-deductible", "#16a34a"],
  [HOLIDAY_TAG, "#f59e0b"],
  ["work", "#0ea5e9"],
];
const tagId = {};
TAGS.forEach((t, i) => {
  const id = i + 1;
  tagId[t[0]] = id;
  S(
    `INSERT INTO tags (id,slug,color,is_active) VALUES (${id},${q(t[0])},${q(t[1])},true);`,
  );
});
const seenTL = new Set();
for (const l of tagLinks) {
  const k = l.txId + ":" + l.slug;
  if (seenTL.has(k)) continue;
  seenTL.add(k);
  S(
    `INSERT INTO transaction_tags (transaction_id,tag_id) VALUES (${l.txId},${tagId[l.slug]});`,
  );
}

// ===== Splits =====
const friends = ["Thomas Peeters", "Sarah Maes", "Lukas De Smet"];
let splitId = 0,
  payId = 0;
const chosen = [];
for (
  let i = 0;
  i < splitCands.length && chosen.length < 6;
  i += Math.max(1, Math.floor(splitCands.length / 6))
) {
  chosen.push(splitCands[i]);
}
chosen.forEach((c, idx) => {
  const friend = friends[idx % friends.length];
  const share = Math.round((c.amount / 2) * 100) / 100;
  splitId++;
  const settled = idx % 3 === 0;
  S(
    `INSERT INTO transaction_splits (id,transaction_id,recipient_id,amount,note,is_settled) VALUES (${splitId},${c.txId},${recId[friend]},${num(share, 2)},${q("Gedeelde rekening met " + friend)},${settled});`,
  );
  if (settled) {
    payId++;
    S(
      `INSERT INTO split_payments (id,split_id,amount,paid_at,note) VALUES (${payId},${splitId},${num(share, 2)},'${fmt(addDaysUTC(c.date, ri(2, 20)))}','Terugbetaald');`,
    );
  } else if (idx % 3 === 1) {
    const part = Math.round((share / 2) * 100) / 100;
    payId++;
    S(
      `INSERT INTO split_payments (id,split_id,amount,paid_at,note) VALUES (${payId},${splitId},${num(part, 2)},'${fmt(addDaysUTC(c.date, ri(2, 15)))}','Deelbetaling');`,
    );
  }
});

// ===== Planned / recurring =====
let planId = 0;
function planned(
  date,
  amount,
  recip,
  catKey,
  memo,
  recurring,
  pattern,
  reminder = null,
) {
  planId++;
  S(
    `INSERT INTO planned_transactions (id,planned_date,amount,currency,memo,recipient_id,category_id,is_recurring,recurrence_pattern,is_executed,is_active,reminder_days_before) VALUES (${planId},'${fmt(date)}',${num(amount, 2)},'EUR',${q(memo)},${recId[recip]},${catId[catKey]},${recurring},${pattern ? q(pattern) : "NULL"},false,true,${reminder === null ? "NULL" : reminder});`,
  );
  return planId;
}
planned(
  ymd(2026, 6, 25),
  3502,
  "Tech Solutions BVBA",
  "INCOME:SALARY",
  "Loon (gepland)",
  true,
  "monthly",
);
planned(
  ymd(2026, 7, 5),
  1442,
  "Creatief Bureau BVBA",
  "INCOME:SALARY",
  "Loon partner (gepland)",
  true,
  "monthly",
);
planned(
  ymd(2026, 6, 18),
  -13.99,
  "Netflix",
  "LEISURE:STREAMING",
  "Netflix (gepland)",
  true,
  "monthly",
);
planned(
  ymd(2026, 7, 2),
  -29.99,
  "Basic-Fit",
  "LEISURE:SPORT",
  "Fitness (gepland)",
  true,
  "monthly",
);
planned(
  ymd(2026, 6, 20),
  -500,
  "DEGIRO",
  "FINANCE:INVESTMENT",
  "Maandelijkse belegging",
  true,
  "monthly",
);
planned(
  ymd(2026, 8, 14),
  -612.4,
  "AG Insurance",
  "HOUSING:INSURANCE",
  "Autoverzekering jaarpremie",
  false,
  null,
  7,
);
planned(
  ymd(2026, 10, 15),
  -1180,
  "FOD Financien",
  "FINANCE:TAX",
  "Personenbelasting (verwacht)",
  false,
  null,
  14,
);

// ===== Loan (mortgage) + amortization schedule =====
let loanSchedId = 0;
{
  const principal = MORTGAGE.principal,
    annual = MORTGAGE.annual,
    termM = MORTGAGE.termM;
  const r = _mr,
    pay = MORTGAGE_PAY;
  const startDate = MORTGAGE.start;
  planId++;
  const nextDue = ymd(2026, 7, 1);
  S(
    `INSERT INTO planned_transactions (id,planned_date,amount,currency,memo,recipient_id,category_id,is_recurring,recurrence_pattern,is_executed,is_active,is_loan,loan_type,loan_principal,loan_annual_interest_rate,loan_term_months,loan_start_date,loan_payment_day,loan_regular_payment_amount,loan_first_payment_date) VALUES (${planId},'${fmt(nextDue)}',${num(-pay, 2)},'EUR','Hypotheek woning Gent',${recId["KBC Woonkrediet"]},${catId["HOUSING:MORTGAGE"]},true,'monthly',false,true,true,'annuity',${num(principal, 2)},${num(annual, 4)},${termM},'${fmt(startDate)}',3,${num(pay, 2)},'${fmt(startDate)}');`,
  );
  const loanPlanId = planId;
  let bal = principal;
  for (let i = 1; i <= termM; i++) {
    const interest = bal * r;
    const princ = pay - interest;
    bal = Math.max(0, bal - princ);
    const due = ymd(2018, 5 + i, 1);
    loanSchedId++;
    S(
      `INSERT INTO planned_transaction_loan_schedule (id,planned_transaction_id,installment_number,due_date,payment_amount,principal_amount,interest_amount,remaining_principal) VALUES (${loanSchedId},${loanPlanId},${i},'${fmt(due)}',${num(pay, 2)},${num(princ, 2)},${num(interest, 2)},${num(bal, 2)});`,
    );
  }
}

// ===== Investments + portfolio txns + price history + FX =====
let invId = 0,
  ptxId = 0,
  aphId = 0;
// Daily price history so charts (net worth, performance) and drag-to-compare
// scrubbing are day-granular. vol/bias are calibrated for a weekly walk; rescale
// to PRICE_STEP_DAYS so total drift and spread over the window stay the same when
// the step shrinks (7× more steps would otherwise widen the random walk ~√7×).
const PRICE_STEP_DAYS = 1;
const STEP_K = Math.sqrt(7 / PRICE_STEP_DAYS);
function priceSeries(startDate, basePrice, vol, bias) {
  const stepVol = vol / STEP_K;
  const stepBias = 0.5 - (0.5 - bias) / STEP_K;
  const pts = [];
  let p = basePrice * (0.72 + rand() * 0.12);
  let cur = new Date(startDate);
  while (cur <= TODAY) {
    p = Math.max(basePrice * 0.3, p * (1 + (rand() - stepBias) * stepVol));
    pts.push([new Date(cur), p]);
    cur = addDaysUTC(cur, PRICE_STEP_DAYS);
  }
  return pts;
}
function priceAt(series, date) {
  let v = series[0][1];
  for (const [d, p] of series) {
    if (d <= date) v = p;
    else break;
  }
  return v;
}
function emitHistory(series, investmentId) {
  for (const [d, p] of series) {
    aphId++;
    S(
      `INSERT INTO asset_price_history (id,investment_id,price_date,close_price,source) VALUES (${aphId},${investmentId},'${fmt(d)}',${num(p, 6)},'manual');`,
    );
  }
}

// USD→EUR daily series into exchange_rates (rate_to_eur = EUR per 1 USD). The whole
// series gives point-in-time FX (ADR-085); only the most recent row is is_latest=true.
// Daily so FX-converted holdings move smoothly; per-step vol scaled by STEP_K to
// keep the same overall spread the weekly walk had.
let ercId = 0;
const fxSeries = [];
{
  const fxVol = 0.02 / STEP_K;
  let cur = ymd(2024, 1, 1);
  let r = 0.92;
  const rows = [];
  while (cur <= TODAY) {
    r = Math.max(0.84, Math.min(0.98, r * (1 + (rand() - 0.5) * fxVol)));
    fxSeries.push([new Date(cur), r]);
    rows.push([new Date(cur), r]);
    cur = addDaysUTC(cur, PRICE_STEP_DAYS);
  }
  rows.forEach(([d, rate], i) => {
    ercId++;
    S(
      `INSERT INTO exchange_rates (id,currency_code,rate_to_eur,rate_date,is_latest) VALUES (${ercId},'USD',${num(rate, 10)},'${fmt(d)}',${i === rows.length - 1 ? "true" : "false"});`,
    );
  });
}
const fxAt = (date) => {
  let v = fxSeries[0][1];
  for (const [d, r] of fxSeries) {
    if (d <= date) v = r;
    else break;
  }
  return v;
};

function unitInv(cls, name, sym, ccy, basePrice, vol, bias, accountId) {
  invId++;
  const id = invId;
  const series = priceSeries(ymd(2024, 1, 1), basePrice, vol, bias);
  const cur = series[series.length - 1][1];
  S(
    `INSERT INTO investments (id,name,symbol,asset_class,currency,is_active,price_provider,current_price) VALUES (${id},${q(name)},${q(sym)},'${cls}',${q(ccy)},true,'manual',${num(cur, 6)});`,
  );
  emitHistory(series, id);
  return { id, ccy, series, basePrice, cls, accountId };
}
// `acctId` defaults to the holding's custody account (ADR-091 per-account positioning); pass an
// override to split one security's lots across accounts ("AAPL at IBKR + a slice at Degiro").
function buy(inv, date, units, acctId = inv.accountId) {
  const ppu = priceAt(inv.series, date);
  const amount = units * ppu;
  const fx = inv.ccy === "USD" ? fxAt(date) : 1;
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,fees,taxes,currency,units,price_per_unit,fx_rate_to_eur,account_id) VALUES (${ptxId},${inv.id},'buy','${fmt(date)}',${num(amount, 4)},${num(rf(0, 4), 4)},0,${q(inv.ccy)},${num(units, 8)},${num(ppu, 6)},${num(fx, 10)},${acctId ?? "NULL"});`,
  );
}
function dividend(inv, date, amount, acctId = inv.accountId) {
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,fees,taxes,currency,fx_rate_to_eur,account_id) VALUES (${ptxId},${inv.id},'dividend','${fmt(date)}',${num(amount, 4)},0,${num(amount * 0.3, 4)},${q(inv.ccy)},${inv.ccy === "USD" ? num(fxAt(date), 10) : 1},${acctId ?? "NULL"});`,
  );
}

function dcaUnit(
  cls,
  name,
  sym,
  ccy,
  basePrice,
  vol,
  bias,
  unitsRange,
  accountId,
) {
  const inv = unitInv(cls, name, sym, ccy, basePrice, vol, bias, accountId);
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2024 && m === 1) continue;
      if (y === 2026 && m > 6) break;
      const d = ymd(y, m, Math.min(21, daysInMonth(y, m)));
      if (d > TODAY) continue;
      buy(inv, d, rf(unitsRange[0], unitsRange[1]));
    }
  }
  return inv;
}
function lumpUnit(
  cls,
  name,
  sym,
  ccy,
  basePrice,
  vol,
  bias,
  unitsRange,
  nBuys,
  accountId,
) {
  const inv = unitInv(cls, name, sym, ccy, basePrice, vol, bias, accountId);
  for (let i = 0; i < nBuys; i++) {
    const y = ri(2024, 2025);
    const m = ri(1, 12);
    const d = ymd(y, m, ri(1, 28));
    if (d > TODAY) continue;
    buy(inv, d, rf(unitsRange[0], unitsRange[1]));
  }
  return inv;
}

const iwda = dcaUnit(
  "etf",
  "iShares Core MSCI World UCITS ETF",
  "IWDA",
  "EUR",
  96.5,
  0.035,
  0.46,
  [3, 6],
  AID.DEGIRO,
);
dcaUnit(
  "etf",
  "Vanguard FTSE All-World UCITS ETF",
  "VWCE",
  "EUR",
  118.2,
  0.035,
  0.46,
  [1.5, 3.5],
  AID.DEGIRO,
);
const aapl = lumpUnit(
  "stock",
  "Apple Inc.",
  "AAPL",
  "USD",
  212,
  0.05,
  0.47,
  [2, 6],
  6,
  AID.IBKR,
);
buy(aapl, ymd(2024, 5, 10), 3, AID.DEGIRO); // a slice of AAPL custodied at Degiro -> split position (ADR-091)
buy(aapl, ymd(2025, 3, 12), 2.5, AID.DEGIRO);
lumpUnit(
  "stock",
  "ASML Holding NV",
  "ASML",
  "EUR",
  905,
  0.06,
  0.46,
  [0.5, 1.5],
  4,
  AID.IBKR,
);
lumpUnit(
  "crypto",
  "Bitcoin",
  "BTC",
  "EUR",
  61500,
  0.1,
  0.45,
  [0.01, 0.05],
  6,
  AID.BITVAVO,
);
lumpUnit(
  "crypto",
  "Ethereum",
  "ETH",
  "EUR",
  3050,
  0.11,
  0.45,
  [0.1, 0.7],
  6,
  AID.BITVAVO,
);
lumpUnit(
  "metals",
  "Physical Gold (XAU)",
  "XAU",
  "EUR",
  2280,
  0.03,
  0.46,
  [1, 4],
  3,
  AID.IBKR,
);
dividend(aapl, ymd(2025, 2, 13), 22.5);
dividend(aapl, ymd(2025, 8, 14), 24.1);
dividend(iwda, ymd(2025, 6, 20), 68.0);

// Cash-like / illiquid holdings — flat investments table, asset_class distinguishes them.
// The term deposit sits at the savings account; the state bond at Degiro; the home is
// unassigned (not held inside a financial account) -> shows as the "unassigned" net-worth row.
invId++;
{
  const id = invId;
  S(
    `INSERT INTO investments (id,name,asset_class,currency,is_active,price_provider,current_price,interest_rate) VALUES (${id},'KBC Termijnrekening','savings','EUR',true,'manual',15250.00,2.5000);`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency,account_id) VALUES (${ptxId},${id},'buy','${fmt(ymd(2024, 1, 15))}',12000.0000,'EUR',${AID.SAVINGS});`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency,account_id) VALUES (${ptxId},${id},'interest','${fmt(ymd(2025, 1, 2))}',180.0000,'EUR',${AID.SAVINGS});`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency,account_id) VALUES (${ptxId},${id},'buy','${fmt(ymd(2025, 6, 10))}',3000.0000,'EUR',${AID.SAVINGS});`,
  );
}
invId++;
{
  const id = invId;
  const maturityDate = ymd(2027, 9, 4);
  S(
    `INSERT INTO investments (id,name,asset_class,currency,is_active,price_provider,current_price,interest_rate,maturity_date) VALUES (${id},'Belgische Staatsbon ${maturityDate.getUTCFullYear()}','bond','EUR',true,'manual',5000.000000,2.8500,'${fmt(maturityDate)}');`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency,account_id) VALUES (${ptxId},${id},'buy','${fmt(ymd(2024, 9, 4))}',5000.0000,'EUR',${AID.DEGIRO});`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency,account_id) VALUES (${ptxId},${id},'interest','${fmt(ymd(2025, 9, 4))}',142.5000,'EUR',${AID.DEGIRO});`,
  );
}
invId++;
{
  const id = invId;
  S(
    `INSERT INTO investments (id,name,asset_class,currency,is_active,price_provider,current_price,location,municipality,cadastral_income,municipality_tax_rate) VALUES (${id},'Appartement Gent','real_estate','EUR',true,'manual',325000.000000,'Korenmarkt, Gent','Gent',1450.00,7.5000);`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency) VALUES (${ptxId},${id},'buy','${fmt(ymd(2018, 5, 1))}',298000.0000,'EUR');`,
  );
  ptxId++;
  S(
    `INSERT INTO portfolio_transactions (id,investment_id,type,date,amount,currency) VALUES (${ptxId},${id},'appreciation','${fmt(ymd(2025, 12, 31))}',27000.0000,'EUR');`,
  );
}

// ===== Watchlist =====
let wlId = 0;
[
  ["Tesla Inc.", "TSLA", "stock", "USD", 180],
  ["Microsoft Corp.", "MSFT", "stock", "USD", 380],
  ["VanEck Semiconductor ETF", "SMH", "etf", "USD", 250],
  ["Solana", "SOL", "crypto", "EUR", 120],
].forEach((w) => {
  wlId++;
  S(
    `INSERT INTO watchlist (id,name,symbol,asset_class,target_price,currency) VALUES (${wlId},${q(w[0])},${q(w[1])},'${w[2]}',${num(w[4], 6)},${q(w[3])});`,
  );
});

// ===== Belgian tax profile (user_settings) =====
// Married dual-income household in Ghent (Flanders), one child, owns home with a
// pre-2020 mortgage (woonbonus), pension savings. Dividend/interest match portfolio.
const taxProfile = {
  profileConfigured: true,
  employmentType: "employee",
  grossAnnualIncome: 58000,
  professionalExpenseMethod: "lump_sum",
  actualProfessionalExpenses: 0,
  communalSurchargePercent: 6.9,
  region: "flanders",
  dependentChildren: 1,
  dependentChildrenUnder3: 0,
  dependentOtherPersons: 0,
  isDisabled: false,
  isSpouseDisabled: false,
  isIsolatedParent: false,
  cadastralIncome: 1450,
  otherTaxableIncome: 0,
  alimonyPaid: 0,
  personalPensionContributions: 990,
  pensionScheme: "1050",
  pensionEligible: true,
  lifeInsurancePremiums: 0,
  mortgageInterestPaid: 3300,
  mortgageCapitalRepaid: 7900,
  mortgageStartYear: MORTGAGE.start.getUTCFullYear(),
  mortgageRegion: "flanders",
  mortgageIsPrimaryResidence: true,
  charitableDonations: 120,
  charitableDonationsEligible: true,
  childcareCosts: 0,
  employeeGroupInsuranceContributions: 0,
  unionDues: 145,
  medicalExpenses: 0,
  filingStatus: "married_joint",
  spouseProfessionalIncome: 22000,
  annualDividendIncome: 115,
  annualSavingsInterest: 60,
  taxIncomeCategoryIds: [catId["INCOME:SALARY"], catId["INCOME:BONUS"]],
  taxYear: ymd(2025, 12, 31).getUTCFullYear(),
};
S(
  `INSERT INTO user_settings (key,value) VALUES ('belgian_tax_profile', '${JSON.stringify(taxProfile).replace(/'/g, "''")}'::jsonb);`,
);
S(
  "INSERT INTO user_settings (key,value) VALUES ('onboarding_complete', 'true'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;",
);

// ===== Reset sequences =====
const seqs = [
  ["accounts_id_seq", 6],
  ["categories_id_seq", CATS.length],
  ["recipients_id_seq", RECIPS.length],
  ["recipient_bank_accounts_id_seq", 3],
  ["recipient_match_patterns_id_seq", 2],
  ["transactions_id_seq", txId],
  ["tags_id_seq", TAGS.length],
  ["transaction_splits_id_seq", splitId],
  ["split_payments_id_seq", payId],
  ["planned_transactions_id_seq", planId],
  ["planned_transaction_loan_schedule_id_seq", loanSchedId],
  ["investments_id_seq", invId],
  ["portfolio_transactions_id_seq", ptxId],
  ["asset_price_history_id_seq", aphId],
  ["exchange_rates_id_seq", ercId],
  ["watchlist_id_seq", wlId],
];
for (const [s, v] of seqs) {
  if (v > 0) S(`SELECT setval('public.${s}',${v},true);`);
}

export const demoSeedSql = out.join("\n") + "\n";
export const demoSeedReferenceDate = fmt(REFERENCE_DATE);
export const demoSeedSummary = Object.freeze({
  accounts: 6,
  transactions: txId,
  recipients: RECIPS.length,
  investments: invId,
  portfolioTransactions: ptxId,
  assetPriceHistory: aphId,
  plannedTransactions: planId,
  transactionSplits: splitId,
});

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.stdout.write(demoSeedSql);
  process.stderr.write(
    `generated: ${txId} transactions across 6 accounts (checking·savings·2 brokerage·crypto-exchange·liability), ${RECIPS.length} recipients, ${invId} investments, ${ptxId} portfolio txns, ${aphId} price points, ${planId} planned, ${splitId} splits\n`,
  );
}
