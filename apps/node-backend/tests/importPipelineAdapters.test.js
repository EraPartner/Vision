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
import { parse as parseWise } from '../src/services/importPipeline/adapters/wise.js';

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

  it('parses %d-%m-%Y dates (previously silently imported zero rows)', async () => {
    const cfg = { ...config, date_format: '%d-%m-%Y' };
    const csv = [
      'Date,Amount,Payee,Note,Cur',
      '31-12-2024,"-10,00",SHOP,x,EUR',
      '01-01-2025,"20,00",EMP,y,EUR',
    ].join('\n');
    const txns = await parseGeneric(writeTempCSV('generic', csv), cfg);

    expect(txns).toHaveLength(2);
    expect(txns[0].date.toISOString().slice(0, 10)).toBe('2024-12-31');
    expect(txns[1].date.toISOString().slice(0, 10)).toBe('2025-01-01');
  });

  it('parses %Y-%m-%d %H:%M:%S as a UTC calendar day (no early-morning day-shift)', async () => {
    const cfg = { ...config, date_format: '%Y-%m-%d %H:%M:%S' };
    const csv = ['Date,Amount,Payee,Note,Cur', '2024-12-31 00:30:00,"5,00",X,n,EUR'].join('\n');
    const txns = await parseGeneric(writeTempCSV('generic', csv), cfg);

    expect(txns).toHaveLength(1);
    expect(txns[0].date.toISOString().slice(0, 10)).toBe('2024-12-31');
  });

  it('reports a skipped count for unparseable rows instead of dropping them silently', async () => {
    const csv = [
      'Date,Amount,Payee,Note,Cur',
      '24/11/2025,"-10,00",SHOP,x,EUR',  // good
      ',"-5,00",NO_DATE,y,EUR',          // bad: empty date → skipped
    ].join('\n');
    const txns = await parseGeneric(writeTempCSV('generic', csv), config);

    expect(txns).toHaveLength(1);
    expect(txns.skipped).toBe(1);
  });

  it('rejects an unsupported date_format instead of importing zero rows', async () => {
    const cfg = { ...config, date_format: '%d.%m.%Y' };
    await expect(
      parseGeneric(writeTempCSV('generic', 'Date,Amount,Payee,Note,Cur\n31.12.2024,"-10,00",S,x,EUR'), cfg),
    ).rejects.toThrow(/Unsupported date_format/);
  });
});

describe('wise adapter — cross-currency direction', () => {
  const HEADER =
    'Status,Finished on,Direction,Source amount (after fees),Source currency,Target amount (after fees),Target currency,Source name,Target name,Reference';

  it('books a cross-currency OUT transfer on the source (your) side', async () => {
    // You send 100 EUR, recipient gets 108 USD → −100 on WISE EUR, not −108 USD.
    const csv = [HEADER, 'COMPLETED,2024-12-31,OUT,100,EUR,108,USD,Me,Shop,Payment'].join('\n');
    const txns = await parseWise(writeTempCSV('wise', csv));

    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-100);
    expect(txns[0].currency).toBe('EUR');
    expect(txns[0].bankAccount).toBe('WISE EUR');
  });

  it('books a cross-currency IN transfer on the target (your) side', async () => {
    const csv = [HEADER, 'COMPLETED,2024-12-31,IN,100,USD,90,EUR,Sender,Me,Salary'].join('\n');
    const txns = await parseWise(writeTempCSV('wise', csv));

    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(90);
    expect(txns[0].currency).toBe('EUR');
    expect(txns[0].bankAccount).toBe('WISE EUR');
  });

  it('parses an early-morning timestamp as a UTC calendar day (no day-shift)', async () => {
    const csv = [HEADER, 'COMPLETED,2024-12-31 00:30:00,IN,0,EUR,90,EUR,Sender,Me,Salary'].join('\n');
    const txns = await parseWise(writeTempCSV('wise', csv));

    expect(txns).toHaveLength(1);
    expect(txns[0].date.toISOString().slice(0, 10)).toBe('2024-12-31');
  });
});
