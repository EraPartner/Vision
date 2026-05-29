/**
 * Golden-fixture tests for the BNP, ING, and generic CSV adapters.
 *
 * These three lacked dedicated coverage of the decimal-parsing edge cases that
 * matter most for a finance importer: comma vs dot decimal separators, thousands
 * separators, currency symbols, parenthetical/leading-sign negatives. Each test
 * writes a temp CSV and runs the real adapter `parse`, asserting the parsed
 * amounts (and that signs survive).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parse as parseBnp } from '../src/services/importPipeline/adapters/bnp.js';
import { parse as parseIng } from '../src/services/importPipeline/adapters/ing.js';
import { parse as parseGeneric } from '../src/services/importPipeline/adapters/generic.js';

const tmpFiles = [];
function writeTempCSV(prefix, content) {
  const p = path.join(os.tmpdir(), `${prefix}_${tmpFiles.length}_${process.pid}.csv`);
  fs.writeFileSync(p, content, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop();
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe('BNP adapter — parseAmountField edge cases', () => {
  const HEADER =
    'Volgnummer;Uitvoeringsdatum;Valutadatum;Bedrag;Valuta rekening;Rekeningnummer;Type verrichting;Tegenpartij;Naam van de tegenpartij;Mededeling;Details;Status;Reden';

  it('parses EU/US/symbol/parenthetical amounts with correct signs', async () => {
    const csv = [
      HEADER,
      '1;24/11/2025;22/11/2025;-67,90;EUR;BE81;BANCONTACT;;SHOP NV;m;d;OK;', // EU comma, negative
      '2;23/11/2025;23/11/2025;2.500,00;EUR;BE81;VIREMENT;BE12;EMPLOYER SA;Salary;;OK;', // EU thousands+comma
      '3;22/11/2025;22/11/2025;1,234.56;EUR;BE81;DEP;;BROKER;;;;', // US thousands+dot
      '4;21/11/2025;21/11/2025;(150,00);EUR;BE81;FEE;;BANK;;;;', // parenthetical negative
      '5;20/11/2025;20/11/2025;€1.000,50;EUR;BE81;TRANSFER;;X;;;;', // currency symbol + EU
    ].join('\n');
    const txns = await parseBnp(writeTempCSV('bnp', csv));

    expect(txns.map((t) => t.amount)).toEqual([-67.9, 2500, 1234.56, -150, 1000.5]);
    expect(txns[0].currency).toBe('EUR');
    expect(txns).toHaveLength(5);
  });

  it('skips rows with an unparseable amount, keeping the valid ones', async () => {
    const csv = [
      HEADER,
      '1;24/11/2025;22/11/2025;abc;EUR;BE81;X;;Y;;;;', // junk amount → skipped
      '2;23/11/2025;23/11/2025;42,00;EUR;BE81;X;;Y;;;;',
    ].join('\n');
    const txns = await parseBnp(writeTempCSV('bnp', csv));
    expect(txns.map((t) => t.amount)).toEqual([42]);
  });
});

describe('ING adapter — parseCommaDecimal', () => {
  const HEADER =
    'Rekeningnummer;Naam;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht';

  it('parses comma-decimal amounts (negative, zero-cents, single-decimal)', async () => {
    const csv = [
      HEADER,
      'BE99;ME;BE12;0001;24/11/2025;24/11/2025;-67,90;EUR;BETALING;SHOP;',
      'BE99;ME;BE12;0002;23/11/2025;23/11/2025;2500,00;EUR;STORTING;EMPLOYER;Salary',
      'BE99;ME;;0003;22/11/2025;22/11/2025;0,01;EUR;RENTE;BANK;',
      'BE99;ME;;0004;21/11/2025;21/11/2025;1234,5;EUR;TEST;X;',
    ].join('\n');
    const txns = await parseIng(writeTempCSV('ing', csv));
    expect(txns.map((t) => t.amount)).toEqual([-67.9, 2500, 0.01, 1234.5]);
    expect(txns).toHaveLength(4);
  });
});

describe('generic adapter — configurable mapping', () => {
  const config = {
    bank_name: 'MyBank',
    account_type: 'checking',
    separator: ',',
    skip_rows: 0,
    date_format: '%d/%m/%Y',
    column_mapping: {
      date: 'Date',
      amount: 'Amount',
      recipient: 'Payee',
      memo: 'Note',
      currency: 'Cur',
    },
  };

  it('maps columns and parses mixed EU/US amounts', async () => {
    const csv = [
      'Date,Amount,Payee,Note,Cur',
      '24/11/2025,"-1.234,56",SHOP,groceries,EUR', // EU
      '23/11/2025,"2,500.00",EMPLOYER,salary,EUR', // US
      '22/11/2025,10.5,BANK,interest,EUR',
    ].join('\n');
    const txns = await parseGeneric(writeTempCSV('generic', csv), config);

    expect(txns.map((t) => t.amount)).toEqual([-1234.56, 2500, 10.5]);
    expect(txns[0].recipient).toBe('SHOP');
    expect(txns[0].currency).toBe('EUR');
    expect(txns[0].bankAccount).toBe('MyBank CHECKING');
    expect(txns).toHaveLength(3);
  });

  it('throws when no config is supplied (generic requires a mapping)', async () => {
    await expect(parseGeneric(writeTempCSV('generic', 'Date,Amount\n1/1/2025,1'))).rejects.toThrow(
      /requires a customConfig/,
    );
  });
});
