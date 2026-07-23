import { describe, expect, it } from 'vitest';
import {
  DEDUCTION_TYPES,
  classifyDeduction,
} from '../src/services/tax/deductionClassifier.js';

describe('DEDUCTION_TYPES', () => {
  it('exposes the stable frozen key set', () => {
    expect(DEDUCTION_TYPES).toEqual([
      'pensionSavings',
      'lifeInsurance',
      'groupInsurance',
      'charitableDonations',
      'childcare',
      'alimony',
      'unionDues',
      'mortgageInterest',
    ]);
    expect(Object.isFrozen(DEDUCTION_TYPES)).toBe(true);
  });
});

describe('classifyDeduction — positives', () => {
  it('pensionSavings (EN + NL)', () => {
    expect(classifyDeduction('PENSION', 'SAVINGS')).toBe('pensionSavings');
    expect(classifyDeduction('SAVINGS', 'PENSION SAVING')).toBe('pensionSavings');
    expect(classifyDeduction('RETIREMENT', 'FUND')).toBe('pensionSavings');
    expect(classifyDeduction('PENSIOENSPAREN', '')).toBe('pensionSavings');
    expect(classifyDeduction('SPAREN', 'PENSIOEN')).toBe('pensionSavings');
  });

  it('lifeInsurance (EN + NL), including INSURANCE:LIFE specifically', () => {
    expect(classifyDeduction('INSURANCE', 'LIFE')).toBe('lifeInsurance');
    expect(classifyDeduction('INSURANCE', 'LIFE INSURANCE')).toBe('lifeInsurance');
    expect(classifyDeduction('VERZEKERING', 'LEVEN')).toBe('lifeInsurance');
    expect(classifyDeduction('LEVENSVERZEKERING', '')).toBe('lifeInsurance');
  });

  it('groupInsurance (EN + NL)', () => {
    expect(classifyDeduction('INSURANCE', 'GROUP')).toBe('groupInsurance');
    expect(classifyDeduction('WORK', 'GROUP INSURANCE')).toBe('groupInsurance');
    expect(classifyDeduction('GROEPSVERZEKERING', '')).toBe('groupInsurance');
  });

  it('classifies employer "group life insurance" as groupInsurance, not lifeInsurance', () => {
    expect(classifyDeduction('INSURANCE', 'GROUP LIFE')).toBe('groupInsurance');
  });

  it('charitableDonations (EN + NL)', () => {
    expect(classifyDeduction('GIVING', 'DONATION')).toBe('charitableDonations');
    expect(classifyDeduction('CHARITY', 'RED CROSS')).toBe('charitableDonations');
    expect(classifyDeduction('GOEDE DOEL', '')).toBe('charitableDonations');
    expect(classifyDeduction('GIFTEN', '')).toBe('charitableDonations');
    expect(classifyDeduction('SCHENKING', 'RODE KRUIS')).toBe('charitableDonations');
  });

  it('childcare (EN + NL, diacritics tolerated)', () => {
    expect(classifyDeduction('CHILDCARE', '')).toBe('childcare');
    expect(classifyDeduction('KIDS', 'CHILD CARE')).toBe('childcare');
    expect(classifyDeduction('KIDS', 'DAYCARE')).toBe('childcare');
    expect(classifyDeduction('KINDEROPVANG', '')).toBe('childcare');
    expect(classifyDeduction('KINDEREN', 'CRÈCHE')).toBe('childcare');
    expect(classifyDeduction('KINDERDAGVERBLIJF', '')).toBe('childcare');
  });

  it('alimony (EN + NL)', () => {
    expect(classifyDeduction('ALIMONY', '')).toBe('alimony');
    expect(classifyDeduction('FAMILY', 'SPOUSAL MAINTENANCE')).toBe('alimony');
    expect(classifyDeduction('ONDERHOUDSGELD', '')).toBe('alimony');
    expect(classifyDeduction('FAMILIE', 'ALIMENTATIE')).toBe('alimony');
  });

  it('unionDues (EN + NL)', () => {
    expect(classifyDeduction('WORK', 'UNION DUES')).toBe('unionDues');
    expect(classifyDeduction('TRADE UNION', 'ACV')).toBe('unionDues');
    expect(classifyDeduction('VAKBOND', '')).toBe('unionDues');
    expect(classifyDeduction('WERK', 'VAKBONDSBIJDRAGE')).toBe('unionDues');
  });

  it('mortgageInterest (EN + NL)', () => {
    expect(classifyDeduction('MORTGAGE', 'INTEREST')).toBe('mortgageInterest');
    expect(classifyDeduction('HOUSE', 'MORTGAGE INTEREST')).toBe('mortgageInterest');
    expect(classifyDeduction('HYPOTHEEKRENTE', '')).toBe('mortgageInterest');
    expect(classifyDeduction('HYPOTHEEK', 'RENTE')).toBe('mortgageInterest');
  });

  it('is case-insensitive', () => {
    expect(classifyDeduction('insurance', 'life')).toBe('lifeInsurance');
    expect(classifyDeduction('Pensioensparen', '')).toBe('pensionSavings');
  });

  it('only ever returns keys from DEDUCTION_TYPES', () => {
    expect(DEDUCTION_TYPES).toContain(classifyDeduction('INSURANCE', 'LIFE'));
    expect(DEDUCTION_TYPES).toContain(classifyDeduction('VAKBOND', ''));
  });
});

describe('classifyDeduction — critical negatives (precision over recall)', () => {
  it('car/home/generic insurance is NOT deductible', () => {
    expect(classifyDeduction('INSURANCE', 'CAR')).toBeNull();
    expect(classifyDeduction('AUTO', 'INSURANCE')).toBeNull();
    expect(classifyDeduction('INSURANCE', '')).toBeNull();
    expect(classifyDeduction('VERZEKERING', 'AUTO')).toBeNull();
    expect(classifyDeduction('WONING', 'VERZEKERING')).toBeNull();
    expect(classifyDeduction('INSURANCE', 'HOME')).toBeNull();
  });

  it('medical / health is no longer matched (old heuristic over-matched it)', () => {
    expect(classifyDeduction('MEDICAL', 'PHARMACY')).toBeNull();
    expect(classifyDeduction('HEALTH', 'MEDICAL')).toBeNull();
  });

  it('generic gifts are presents, not donations', () => {
    expect(classifyDeduction('GIFTS', 'BIRTHDAY')).toBeNull();
    expect(classifyDeduction('GIFT', 'CHRISTMAS')).toBeNull();
  });

  it('everyday spending is null', () => {
    expect(classifyDeduction('FOOD', 'GROCERIES')).toBeNull();
  });

  it('tax and tuition are no longer matched (old heuristic over-matched them)', () => {
    expect(classifyDeduction('TAX', 'INCOME TAX')).toBeNull();
    expect(classifyDeduction('TUITION', 'UNIVERSITY')).toBeNull();
  });

  it('plain mortgage repayment (no interest word) is conservatively null', () => {
    expect(classifyDeduction('MORTGAGE', 'REPAYMENT')).toBeNull();
    expect(classifyDeduction('HYPOTHEEK', 'KAPITAAL')).toBeNull();
  });

  it('bare MAINTENANCE (home/car) and bare UNION are not matched', () => {
    expect(classifyDeduction('HOME', 'MAINTENANCE')).toBeNull();
    expect(classifyDeduction('CREDIT UNION', 'FEES')).toBeNull();
  });

  it('token matching is not substring matching', () => {
    // "PENSIONER" contains "pension" as a substring but is not the token.
    expect(classifyDeduction('PENSIONERS CLUB', 'MEMBERSHIP')).toBeNull();
    // "GIFTENSHOP" contains "GIFTEN" as a substring only.
    expect(classifyDeduction('GIFTENSHOP', '')).toBeNull();
  });

  it('empty / null input is null', () => {
    expect(classifyDeduction('', '')).toBeNull();
    expect(classifyDeduction(null, undefined)).toBeNull();
  });
});
