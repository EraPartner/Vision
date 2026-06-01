import Decimal from 'decimal.js';

export type DecimalInput = number | string | Decimal | null | undefined;

export function toDecimal(v: DecimalInput): Decimal;
export function addAll(values: DecimalInput[]): Decimal;
export function subtract(a: DecimalInput, b: DecimalInput): Decimal;
export function roundToCents(v: DecimalInput): Decimal;
export function multiply(a: DecimalInput, b: DecimalInput): Decimal;
export function divide(a: DecimalInput, b: DecimalInput): Decimal;
export function roundMoney(v: DecimalInput, places?: number): number;
export function toNumber(v: DecimalInput): number;

export { Decimal };
