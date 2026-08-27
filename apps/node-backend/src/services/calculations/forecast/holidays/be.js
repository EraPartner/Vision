/**
 * Belgian public holidays — fixed-date + Easter-derived.
 * Returns 'YYYY-MM-DD' set for a given year.
 * Holidays: New Year, Easter Monday, Labour Day, Ascension, Pentecost Monday,
 * Belgian National Day (21 Jul), Assumption (15 Aug), All Saints (1 Nov),
 * Armistice (11 Nov), Christmas (25 Dec).
 */

/** @param {number} n */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 */
function isoDate(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** @param {number} year */
function easterSunday(year) {
  // Anonymous Gregorian Computus.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * @param {Date} date
 * @param {number} days
 */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** @param {number} year */
function belgianHolidays(year) {
  const easter = easterSunday(year);
  const easterMonday = addDays(easter, 1);
  const ascension = addDays(easter, 39);
  const pentecostMonday = addDays(easter, 50);

  return new Set([
    isoDate(year, 1, 1),
    isoDate(easterMonday.getUTCFullYear(), easterMonday.getUTCMonth() + 1, easterMonday.getUTCDate()),
    isoDate(year, 5, 1),
    isoDate(ascension.getUTCFullYear(), ascension.getUTCMonth() + 1, ascension.getUTCDate()),
    isoDate(pentecostMonday.getUTCFullYear(), pentecostMonday.getUTCMonth() + 1, pentecostMonday.getUTCDate()),
    isoDate(year, 7, 21),
    isoDate(year, 8, 15),
    isoDate(year, 11, 1),
    isoDate(year, 11, 11),
    isoDate(year, 12, 25),
  ]);
}

/** @param {string} isoDateStr */
export function isBelgianHoliday(isoDateStr) {
  const year = Number(isoDateStr.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return belgianHolidays(year).has(isoDateStr);
}

export default { belgianHolidays, isBelgianHoliday };
