/**
 * PortfolioTxnFormFields — the shared type/date/account/units/price/amount/
 * fees/taxes/FX/recurring/note field body for the portfolio Add and Edit
 * transaction dialogs, which were ~90% identical JSX.
 *
 * The `type` control differs between the dialogs (an editable Select on Add, a
 * disabled Input on Edit), so it is supplied by each caller via the `typeField`
 * slot. Everything else is parameterised so the exact per-dialog behaviour is
 * preserved: `idPrefix` keeps the input ids stable, `withPlaceholders` toggles
 * the Add-only placeholders, and `lockAmountWhenGift` reproduces Add's
 * gift-locks-the-amount rule (Edit keeps the amount editable for gifts).
 */

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DatePicker } from '@/components/shared/DatePicker';
import { parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';
import { isPerAccountHoldingsEnabled } from '@/lib/env';
import type { RecurrenceInterval } from '@/types/portfolio';
import type { Account } from '@/types/api';

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** The transaction fields the shared body reads and writes. */
export interface PortfolioTxnFieldsForm {
  date: string;
  amount: string;
  units: string;
  pricePerUnit: string;
  fees: string;
  taxes: string;
  fxRateToEur: string;
  note: string;
  accountId: string;
  isRecurring: boolean;
  recurrenceInterval: RecurrenceInterval;
  recurrenceEndDate: string;
}

/** Localised labels for the recurrence-interval dropdown (shared by both dialogs). */
function buildRecurrenceLabels(t: TranslateFn): Record<RecurrenceInterval, string> {
  return {
    daily: t('addPortTxn.recurrence.daily'),
    weekly: t('addPortTxn.recurrence.weekly'),
    'bi-weekly': t('addPortTxn.recurrence.biweekly'),
    monthly: t('addPortTxn.recurrence.monthly'),
    quarterly: t('addPortTxn.recurrence.quarterly'),
    yearly: t('addPortTxn.recurrence.yearly'),
  };
}

interface PortfolioTxnFormFieldsProps<F extends PortfolioTxnFieldsForm> {
  /** Prefix for input ids so htmlFor targets stay unique per dialog. */
  idPrefix: string;
  form: F;
  setForm: (updater: (prev: F) => F) => void;
  currency: string;
  t: TranslateFn;
  /** The type control (editable on Add, read-only on Edit). */
  typeField: ReactNode;
  accounts: Account[];
  showUnits: boolean;
  showFeesTaxes: boolean;
  showRecurring: boolean;
  derivedAmount?: number;
  isBuySell: boolean;
  buySellIsValid: boolean;
  isGift: boolean;
  /** Add locks the amount to 0 for gifts; Edit leaves it editable. */
  lockAmountWhenGift: boolean;
  /** Add renders example placeholders; Edit renders none. */
  withPlaceholders: boolean;
}

export function PortfolioTxnFormFields<F extends PortfolioTxnFieldsForm>({
  idPrefix,
  form,
  setForm,
  currency,
  t,
  typeField,
  accounts,
  showUnits,
  showFeesTaxes,
  showRecurring,
  derivedAmount,
  isBuySell,
  buySellIsValid,
  isGift,
  lockAmountWhenGift,
  withPlaceholders,
}: PortfolioTxnFormFieldsProps<F>) {
  const recurrenceLabels = buildRecurrenceLabels(t);
  const lockAmount = isGift && lockAmountWhenGift;
  const amountPlaceholder = withPlaceholders
    ? (lockAmount ? '0.00' : (derivedAmount !== undefined ? derivedAmount.toFixed(4) : '0.00'))
    : undefined;

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        {typeField}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-date`}>{t('addPortTxn.date')}</Label>
          <DatePicker
            value={form.date ? parseLocalDateFromYmd(form.date) : undefined}
            onChange={(date) => setForm((f) => ({ ...f, date: date ? toYmd(date) : '' }))}
            placeholder={t('plannedPage.link.pickDate')}
          />
        </div>

        {isPerAccountHoldingsEnabled && (
          <div className="space-y-2 col-span-2">
            <Label>{t('nav.accounts')}</Label>
            <Select
              value={form.accountId || 'none'}
              onValueChange={(v) => setForm((f) => ({ ...f, accountId: v === 'none' ? '' : v }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('accounts.unassigned')}</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>{a.display_name || a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {showUnits && (
          <>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-units`}>{t('addPortTxn.units')}</Label>
              <Input
                id={`${idPrefix}-units`}
                type="number"
                step="0.000001"
                min="0"
                placeholder={withPlaceholders ? '10' : undefined}
                value={form.units}
                onChange={(e) => setForm((f) => ({ ...f, units: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-ppu`}>{t('addPortTxn.pricePerUnit')}</Label>
              <Input
                id={`${idPrefix}-ppu`}
                type="number"
                step="0.0001"
                min="0"
                placeholder={withPlaceholders ? '98.50' : undefined}
                value={form.pricePerUnit}
                onChange={(e) => setForm((f) => ({ ...f, pricePerUnit: e.target.value }))}
              />
            </div>
          </>
        )}

        <div className={`space-y-2 ${showUnits ? 'col-span-2' : ''}`}>
          <Label htmlFor={`${idPrefix}-amount`}>
            {t('addPortTxn.totalAmount', { currency })}
            {lockAmount
              ? <span className="text-muted-foreground ml-1 text-xs">= 0</span>
              : (derivedAmount !== undefined
                ? <span className="text-muted-foreground ml-1 text-xs">= {derivedAmount.toFixed(4)}</span>
                : null)}
          </Label>
          <Input
            id={`${idPrefix}-amount`}
            type="number"
            step="0.0001"
            min="0"
            placeholder={amountPlaceholder}
            value={lockAmount ? '0' : form.amount}
            disabled={lockAmount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>

        {isBuySell && !buySellIsValid && (
          <div className="col-span-2 text-xs text-destructive">{t('addPortTxn.error.twoOfThreeRequired')}</div>
        )}

        {showFeesTaxes && (
          <>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-fees`}>{t('addPortTxn.fees')}</Label>
              <Input
                id={`${idPrefix}-fees`}
                type="number"
                step="0.01"
                min="0"
                placeholder={withPlaceholders ? '0.00' : undefined}
                value={form.fees}
                onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-taxes`}>{t('addPortTxn.taxes')}</Label>
              <Input
                id={`${idPrefix}-taxes`}
                type="number"
                step="0.01"
                min="0"
                placeholder={withPlaceholders ? '0.00' : undefined}
                value={form.taxes}
                onChange={(e) => setForm((f) => ({ ...f, taxes: e.target.value }))}
              />
            </div>
          </>
        )}

        <div className={`space-y-2 ${showFeesTaxes ? 'col-span-2' : ''}`}>
          <Label htmlFor={`${idPrefix}-fx-rate-to-eur`}>FX rate to EUR (optional)</Label>
          <Input
            id={`${idPrefix}-fx-rate-to-eur`}
            type="number"
            step="0.0000000001"
            min="0"
            placeholder={withPlaceholders ? '1.0000000000' : undefined}
            value={form.fxRateToEur}
            onChange={(e) => setForm((f) => ({ ...f, fxRateToEur: e.target.value }))}
          />
        </div>
      </div>

      {showRecurring && (
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${idPrefix}-recurring`} className="text-sm">{t('addPortTxn.recurring')}</Label>
            <Switch
              id={`${idPrefix}-recurring`}
              checked={form.isRecurring}
              onCheckedChange={(v) => setForm((f) => ({ ...f, isRecurring: v }))}
            />
          </div>
          {form.isRecurring && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t('addPortTxn.interval')}</Label>
                <Select
                  value={form.recurrenceInterval}
                  onValueChange={(v) => setForm((f) => ({ ...f, recurrenceInterval: v as RecurrenceInterval }))}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(recurrenceLabels).map(([k, l]) => (
                      <SelectItem key={k} value={k}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('addPortTxn.endDate')}</Label>
                <DatePicker
                  value={form.recurrenceEndDate ? parseLocalDateFromYmd(form.recurrenceEndDate) : undefined}
                  onChange={(date) => setForm((f) => ({ ...f, recurrenceEndDate: date ? toYmd(date) : '' }))}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                  buttonClassName="h-8 text-xs"
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-note`}>{t('addPortTxn.note')}</Label>
        <Textarea
          id={`${idPrefix}-note`}
          placeholder={withPlaceholders ? t('addPortTxn.note') : undefined}
          rows={2}
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          maxLength={300}
        />
      </div>
    </>
  );
}
