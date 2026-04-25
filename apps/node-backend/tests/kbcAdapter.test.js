/**
 * KBC Bank Adapter Tests
 * Mirrors: apps/backend/tests/test_kbc_adapter.py
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAdapter } from '../src/services/bankAdapters.js';

function writeTempCSV(content) {
  const tmpPath = path.join(os.tmpdir(), `test_kbc_${Date.now()}.csv`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

const SAMPLE_KBC_CSV = `Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;BAU IE;EUR;  02026001;03/01/2026;INSTANTOVERSCHRIJVING NAAR;03/01/2026;-775,08;0,00;              ;-775,08;BE89 6509 6582 5185;REVOBEB2XXX;IE BAU;                                                                       ;                                   ;                                                                                                                                             
BE61734041478017;                                                  ;BAU IE;EUR;  02026001;03/01/2026;INSTANTOVERSCHRIJVING VAN;03/01/2026;775,08;775,08;775,08;              ;BE34 7440 1076 7090;KREDBEBBXXX;BAU IE;                                                                       ;                                   ;
BE34744010767090;                                                  ;BAU IE;EUR;  01026001;02/01/2026;OVERSCHRIJVING NAAR;02/01/2026;-1000,00;500,00;              ;-1000,00;BE61 7340 4147 8017;KREDBEBBXXX;BAU IE;                                                                       ;+++123/4567/89012+++              ;Monthly transfer
`;

describe('KBCAdapter', () => {
  let tmpPath;
  const parse = createAdapter('kbc');

  afterEach(() => {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it('parses correct number of transactions', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(3);
  });

  it('detects account type as KBC', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      expect(txn.bankAccount).toBe('KBC');
    }
  });

  it('parses transaction fields correctly', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    const txn1 = txns[0];
    expect(txn1.amount).toBe(-775.08);
    expect(txn1.currency).toBe('EUR');
    expect(txn1.balance).toBe(0.00);
    expect(txn1.recipientAccount).toBe('BE89 6509 6582 5185');
  });

  it('detects credit and debit transactions', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].amount).toBeLessThan(0);
    expect(txns[0].comment).toContain('DEBIT');
    expect(txns[1].amount).toBeGreaterThan(0);
    expect(txns[1].comment).toContain('CREDIT');
  });

  it('extracts BIC codes', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].comment).toContain('BIC: REVOBEB2XXX');
    expect(txns[1].comment).toContain('BIC: KREDBEBBXXX');
  });

  it('extracts structured communication', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[2].comment).toContain('Structured: +++123/4567/89012+++');
  });

  it('extracts free communication', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[2].comment).toContain('Free: Monthly transfer');
  });

  it('extracts statement numbers', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].comment).toContain('Statement: 02026001');
    expect(txns[2].comment).toContain('Statement: 01026001');
  });

  it('extracts recipient accounts', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].recipientAccount).toBe('BE89 6509 6582 5185');
    expect(txns[1].recipientAccount).toBe('BE34 7440 1076 7090');
    expect(txns[2].recipientAccount).toBe('BE61 7340 4147 8017');
  });

  it('parses amounts with comma decimal separator', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].amount).toBe(-775.08);
    expect(txns[1].amount).toBe(775.08);
    expect(txns[2].amount).toBe(-1000.00);
  });

  it('parses balance values', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].balance).toBe(0.00);
    expect(txns[1].balance).toBe(775.08);
    expect(txns[2].balance).toBe(500.00);
  });

  it('normalizes text to uppercase', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      if (txn.recipient) expect(txn.recipient).toBe(txn.recipient.toUpperCase());
      if (txn.memo) expect(txn.memo).toBe(txn.memo.toUpperCase());
      expect(txn.bankAccount).toBe(txn.bankAccount.toUpperCase());
    }
  });

  it('preserves raw data', async () => {
    tmpPath = writeTempCSV(SAMPLE_KBC_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      expect(txn.rawData).toBeTruthy();
      expect(txn.rawData).toContain(';');
    }
  });

  it('skips malformed dates', async () => {
    const csv = SAMPLE_KBC_CSV.replace('03/01/2026;INSTANTOVERSCHRIJVING NAAR', 'INVALID;INSTANTOVERSCHRIJVING NAAR');
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns.length).toBeLessThan(3);
  });

  it('skips malformed amounts', async () => {
    const csv = SAMPLE_KBC_CSV.replace('-775,08;0,00', 'INVALID;0,00');
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns.length).toBeLessThan(3);
  });

  it('handles empty file', async () => {
    tmpPath = writeTempCSV('');
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(0);
  });

  it('handles rows with insufficient columns', async () => {
    const csv = `Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;TEST;EUR
BE61734041478017;                                                  ;TEST;EUR;  12346;03/01/2026;Valid transaction;03/01/2026;-50,00;850,00;              ;-50,00;              ;              ;              ;                                                                       ;                                   ;
`;
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-50.00);
  });
});
