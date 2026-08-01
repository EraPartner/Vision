import { useState } from "react";
import { parseDecimal } from "@/lib/decimal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { AccountCombobox } from "@/components/shared/AccountCombobox";
import { DatePicker } from "@/components/shared/DatePicker";
import { TagInput } from "@/components/shared/TagInput";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { FieldError } from "@/components/ui/field-error";
import { fieldErrorProps, useFieldErrors, type FieldErrorMap } from "@/hooks/useFieldErrors";

type Frequency = PlannedPayment["frequency"];
type LoanType = NonNullable<PlannedPayment["loan_type"]>;

/**
 * Sign convention for a planned payment's stored `amount`: money going OUT is
 * negative, money coming IN is positive. Enforced end-to-end —
 *  - routes/plannedTransactions.js force-negates a loan installment
 *    (`-Math.abs(regular_payment_amount)`) on both create and patch,
 *  - calculations/aggregation/cashflowForecast.js buckets positive amounts as
 *    income and negative as expenses,
 *  - plannedMatchService.matchesTolerance() refuses a (planned, tx) pair whose
 *    signs differ, so a bill stored positive can never auto-clear against the
 *    real negative transaction.
 * The amount input therefore holds an unsigned magnitude and this toggle owns
 * the sign; the two are recombined in handleSubmit.
 */
type Direction = "expense" | "income";

/** Visual order — decides which field gets focus on a blocked submit. */
const FIELD_ORDER = [
  "pp-name",
  "pp-amount",
  "pp-due-date",
  "pp-bank",
  "pp-loan-principal",
  "pp-loan-rate",
  "pp-loan-term",
  "pp-custom-days",
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Omit<PlannedPayment, "id" | "created_at">) => void;
  initial?: PlannedPayment;
}

export default function PlannedPaymentForm({ open, onOpenChange, onSubmit, initial }: Props) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const [name, setName] = useState(initial?.name ?? "");
  // Edit path: the stored amount is signed, the field is a magnitude — split it
  // back into |amount| + direction so re-saving an untouched row is a no-op.
  const [amount, setAmount] = useState(
    initial?.amount != null ? Math.abs(initial.amount).toString() : "",
  );
  // Default to "expense": planned payments are overwhelmingly bills, and it is
  // the direction that keeps a new row auto-matchable against a real debit.
  const [direction, setDirection] = useState<Direction>(
    (initial?.amount ?? 0) > 0 ? "income" : "expense",
  );
  const [currency, setCurrency] = useState(initial?.currency ?? appSettings.defaultCurrency);
  // New planned payments default the (required) due date to today so the form is
  // immediately submittable; editing keeps the stored date.
  const [dueDate, setDueDate] = useState<Date | undefined>(initial?.due_date ? parseLocalDateFromYmd(initial.due_date) : new Date());
  const [isRecurring, setIsRecurring] = useState(initial?.is_recurring ?? false);
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? "monthly");
  const [isLoan, setIsLoan] = useState(initial?.is_loan ?? false);
  const [loanType, setLoanType] = useState<LoanType>(initial?.loan_type ?? "amortizing");
  const [loanPrincipal, setLoanPrincipal] = useState(initial?.loan_principal?.toString() ?? "");
  const [loanRate, setLoanRate] = useState(initial?.loan_annual_interest_rate?.toString() ?? "");
  const [loanTermMonths, setLoanTermMonths] = useState(initial?.loan_term_months?.toString() ?? "");
  const [loanPaymentDay, setLoanPaymentDay] = useState(initial?.loan_payment_day?.toString() ?? "");
  const [customDays, setCustomDays] = useState(initial?.custom_interval_days?.toString() ?? "");
  const [endDate, setEndDate] = useState<Date | undefined>(initial?.end_date ? parseLocalDateFromYmd(initial.end_date) : undefined);
  const [maxOccurrences, setMaxOccurrences] = useState(initial?.max_occurrences?.toString() ?? "");
  const [recipientId, setRecipientId] = useState<number | undefined>(initial?.recipient_id);
  const [categoryId, setCategoryId] = useState<number | undefined>(initial?.category_id);
  const [bankAccount, setBankAccount] = useState(initial?.bank_account ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  const loading = false;

  // A loan installment is always money out, and the server derives its amount
  // from the generated repayment schedule, so the toggle locks to "expense"
  // (same forced-value + disabled idiom as the recurring switch below).
  const effectiveDirection: Direction = isLoan ? "expense" : direction;

  // The same conditions that used to stop submission behind a blocking
  // `alert()`, re-expressed per field: recomputed every render, but only shown
  // once a submit has actually been blocked (see useFieldErrors), so each
  // message clears itself as soon as its own field is fixed.
  const term = parseInt(loanTermMonths, 10);
  const days = parseInt(customDays, 10);
  const fieldErrors: FieldErrorMap = {
    "pp-name": !name.trim() ? t('plannedForm.nameRequired') : undefined,
    "pp-amount": !isLoan && !amount ? t('plannedForm.amountRequired') : undefined,
    "pp-due-date": !dueDate ? t('validation.required') : undefined,
    "pp-bank": !bankAccount.trim() ? t('portfolio.move.selectAccount') : undefined,
    "pp-loan-principal": isLoan && !loanPrincipal ? t('validation.required') : undefined,
    "pp-loan-rate": isLoan && !loanRate ? t('validation.required') : undefined,
    "pp-loan-term": !isLoan
      ? undefined
      : !loanTermMonths
        ? t('validation.required')
        : !Number.isInteger(term) || term < 1 || term > 600
          ? t('plannedForm.loanTermInvalid')
          : undefined,
    // A "custom" pattern with a blank/0 interval reached the backend as the
    // literal pattern "custom" and came back as a raw 400 — block it here.
    "pp-custom-days":
      !isLoan && isRecurring && frequency === "custom" && (!Number.isInteger(days) || days < 1)
        ? t('plannedForm.customDaysInvalid')
        : undefined,
  };
  const { visibleErrors, checkValid, resetErrors } = useFieldErrors(fieldErrors, FIELD_ORDER);

  const handleSubmit = () => {
    if (!checkValid()) return;
    // Narrowing only — `checkValid()` has already blocked a missing due date.
    if (!dueDate) return;

    const dueDateStr = toYmd(dueDate);

    let endDateStr: string | undefined = undefined;
    if (endDate) {
      endDateStr = toYmd(endDate);
    }

    // Recombine magnitude + direction into the signed stored amount. Math.abs
    // guards a stray typed "-" so the toggle is the single source of the sign;
    // the 0 case is spelled out to avoid handing the API a `-0`.
    const magnitude = Math.abs(parseDecimal(amount));
    const signedAmount =
      magnitude === 0 || effectiveDirection === "income" ? magnitude : -magnitude;

    // If loan is enabled, clear recurrence inputs before submitting - loans drive their own schedule
    const payload: Record<string, unknown> = {
      name: name.trim(),
      // Loans: the server owns the amount — POST and PATCH both re-derive it
      // as -|regular_payment_amount| whenever the repayment schedule is
      // (re)generated, ignoring this client value, so there is no double
      // negation and no stale amount on either path.
      amount: signedAmount,
      currency,
      due_date: dueDateStr,
      url: url?.trim() || undefined,
      is_recurring: isLoan ? true : isRecurring,
      is_loan: isLoan,
      ...(isLoan && {
        loan_type: loanType,
        loan_principal: parseDecimal(loanPrincipal),
        loan_annual_interest_rate: parseDecimal(loanRate),
        loan_term_months: parseInt(loanTermMonths, 10),
        loan_start_date: dueDateStr,
        loan_payment_day: loanPaymentDay ? parseInt(loanPaymentDay, 10) : dueDate.getDate(),
        // keep recurrence_pattern undefined here; recurrence display for loans is handled client-side
      }),
      recipient_id: recipientId || undefined,
      category_id: categoryId,
      bank_account: bankAccount || undefined,
      tags: tags.length > 0 ? tags : undefined,
      notes: notes || undefined,
      ...(!isLoan && isRecurring && {
        frequency,
        ...(frequency === "custom" && customDays ? { custom_interval_days: parseInt(customDays) } : {}),
        // Always send the recurrence bounds (null when cleared) — omitting the key
        // makes mapToUpdateAPI leave the old bound in place, so clearing an end
        // date / max count would silently keep the series bounded.
        end_date: endDateStr ?? null,
        max_occurrences: maxOccurrences ? parseInt(maxOccurrences) : null,
      }),
      is_active: initial?.is_active ?? true,
    };

    if (isLoan) {
      // Ensure recurrence-related fields are not sent for loans
      delete payload.frequency;
      delete payload.custom_interval_days;
      delete payload.end_date;
      delete payload.max_occurrences;
      delete payload.recurrence_pattern;
    }

    onSubmit(payload as Omit<PlannedPayment, "id" | "created_at">);
    resetErrors();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <div ref={setPortalContainer} />
        <DialogHeader>
          <DialogTitle>{initial ? t('plannedForm.editTitle') : t('plannedForm.newTitle')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
            {/* Name */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-name">{t('plannedForm.nameRequired2')}</Label>
              <Input id="pp-name" placeholder={t('plannedForm.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} {...fieldErrorProps("pp-name", visibleErrors["pp-name"])} />
              <FieldError field="pp-name" message={visibleErrors["pp-name"]} />
            </div>

            {/* Amount + Currency */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="pp-amount">{t('plannedForm.amountRequired2')}</Label>
                <Input id="pp-amount" type="text" inputMode="decimal" pattern="^[0-9]+([.,][0-9]+)?$" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} {...fieldErrorProps("pp-amount", visibleErrors["pp-amount"])} />
                <FieldError field="pp-amount" message={visibleErrors["pp-amount"]} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pp-currency">{t('plannedForm.currency')}</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger id="pp-currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["EUR", "USD", "GBP", "CHF", "CZK", "PLN"].map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Direction — owns the sign of the amount above (see `Direction`). */}
            <div className="grid gap-1.5">
              {/* Labelled via aria-labelledby, not htmlFor: the group's children
                  are role="radio" buttons, and a `for` association would
                  overwrite their own accessible names with "Direction". */}
              <Label id="pp-direction-label">{t('plannedForm.direction')}</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby="pp-direction-label"
                value={effectiveDirection}
                // Radix emits "" when the active item is re-pressed; ignore it so
                // the control can never end up with no direction selected.
                onValueChange={(v) => { if (v) setDirection(v as Direction); }}
                disabled={isLoan}
                className="grid grid-cols-2 gap-2"
              >
                <ToggleGroupItem
                  id="pp-direction-expense"
                  value="expense"
                  className="w-full data-[state=on]:bg-loss/10 data-[state=on]:text-loss data-[state=on]:shadow-[inset_0_0_0_1px_hsl(var(--loss)/0.35)]"
                >
                  <TrendingDown className="h-4 w-4" aria-hidden="true" />
                  {t('plannedForm.direction.expense')}
                </ToggleGroupItem>
                <ToggleGroupItem
                  id="pp-direction-income"
                  value="income"
                  className="w-full data-[state=on]:bg-gain/10 data-[state=on]:text-gain data-[state=on]:shadow-[inset_0_0_0_1px_hsl(var(--gain)/0.35)]"
                >
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                  {t('plannedForm.direction.income')}
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {isLoan ? t('plannedForm.directionLoanDesc') : t('plannedForm.directionDesc')}
              </p>
            </div>

            {/* Due date */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-due-date">{t('plannedForm.dueDate')}</Label>
              <DatePicker
                id="pp-due-date"
                value={dueDate}
                onChange={setDueDate}
                placeholder={t('plannedForm.pickDate')}
                portalContainer={portalContainer}
                {...fieldErrorProps("pp-due-date", visibleErrors["pp-due-date"])}
              />
              <FieldError field="pp-due-date" message={visibleErrors["pp-due-date"]} />
            </div>

            {/* Recipient */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-recipient">{t('plannedForm.recipient')}</Label>
              <RecipientCombobox
                id="pp-recipient"
                value={recipientId ?? null}
                onSelect={(id) => setRecipientId(id ?? undefined)}
                className="w-full"
                disabled={loading}
                portalContainer={portalContainer}
              />
            </div>

            {/* Category */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-category">{t('plannedForm.category')}</Label>
              <CategoryCombobox
                id="pp-category"
                value={categoryId ?? null}
                onSelect={(id) => setCategoryId(id ?? undefined)}
                className="w-full"
                disabled={loading}
                portalContainer={portalContainer}
              />
            </div>

            {/* Tags */}
            <div className="grid gap-1.5">
              {/* Labelled via aria-labelledby, not htmlFor: the tag control is a
                  role="combobox" <div>, which a <label for> cannot associate with. */}
              <Label id="pp-tags-label">{t('txPage.field.tags')}</Label>
              <TagInput aria-labelledby="pp-tags-label" value={tags} onChange={setTags} />
            </div>

            {/* Bank account */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-bank">{t('plannedForm.bankAccountRequired')}</Label>
              <AccountCombobox
                id="pp-bank"
                value={bankAccount}
                onChange={setBankAccount}
                placeholder={t('plannedForm.bankPlaceholder')}
                {...fieldErrorProps("pp-bank", visibleErrors["pp-bank"])}
              />
              <FieldError field="pp-bank" message={visibleErrors["pp-bank"]} />
            </div>

            {/* Recurring toggle */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="pp-loan" className="font-medium">{t('plannedForm.loan')}</Label>
                <p className="text-xs text-muted-foreground">{t('plannedForm.loanDesc')}</p>
              </div>
              <Switch id="pp-loan" checked={isLoan} onCheckedChange={setIsLoan} />
            </div>

            {isLoan && (
              <div className="grid gap-3 rounded-lg border p-3 bg-muted/30">
                <div className="grid gap-1.5">
                  <Label htmlFor="pp-loan-type">{t('plannedForm.loanType')}</Label>
                  <Select value={loanType} onValueChange={(v) => setLoanType(v as LoanType)}>
                    <SelectTrigger id="pp-loan-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="amortizing">{t('plannedForm.loanType.amortizing')}</SelectItem>
                      <SelectItem value="fixed_principal">{t('plannedForm.loanType.fixedPrincipal')}</SelectItem>
                      <SelectItem value="interest_only">{t('plannedForm.loanType.interestOnly')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-principal">{t('plannedForm.loanPrincipal')}</Label>
                    <Input id="pp-loan-principal" type="text" inputMode="decimal" pattern="^[0-9]+([.,][0-9]+)?$" value={loanPrincipal} onChange={(e) => setLoanPrincipal(e.target.value)} {...fieldErrorProps("pp-loan-principal", visibleErrors["pp-loan-principal"])} />
                    <FieldError field="pp-loan-principal" message={visibleErrors["pp-loan-principal"]} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-rate">{t('plannedForm.loanRate')}</Label>
                    <Input id="pp-loan-rate" type="text" inputMode="decimal" pattern="^[0-9]+([.,][0-9]+)?$" value={loanRate} onChange={(e) => setLoanRate(e.target.value)} {...fieldErrorProps("pp-loan-rate", visibleErrors["pp-loan-rate"])} />
                    <FieldError field="pp-loan-rate" message={visibleErrors["pp-loan-rate"]} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-term">{t('plannedForm.loanTermMonths')}</Label>
                    <Input id="pp-loan-term" type="number" min={1} value={loanTermMonths} onChange={(e) => setLoanTermMonths(e.target.value)} {...fieldErrorProps("pp-loan-term", visibleErrors["pp-loan-term"])} />
                    <FieldError field="pp-loan-term" message={visibleErrors["pp-loan-term"]} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-payment-day">{t('plannedForm.loanPaymentDay')}</Label>
                    <Input id="pp-loan-payment-day" type="number" min={1} max={31} value={loanPaymentDay} onChange={(e) => setLoanPaymentDay(e.target.value)} placeholder={dueDate ? String(dueDate.getDate()) : '1'} />
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="pp-recurring" className="font-medium">{t('plannedForm.recurring')}</Label>
                <p className="text-xs text-muted-foreground">{t('plannedForm.recurringDesc')}</p>
              </div>
              <Switch id="pp-recurring" checked={isLoan ? true : isRecurring} onCheckedChange={setIsRecurring} disabled={isLoan} />
            </div>

            {/* Recurring options */}
            {!isLoan && isRecurring && (
              <div className="grid gap-3 rounded-lg border p-3 bg-muted/30">
                <div className="grid gap-1.5">
                  <Label htmlFor="pp-frequency">{t('plannedForm.frequency')}</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                    <SelectTrigger id="pp-frequency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">{t('plannedForm.freq.daily')}</SelectItem>
                      <SelectItem value="weekly">{t('plannedForm.freq.weekly')}</SelectItem>
                      <SelectItem value="biweekly">{t('plannedForm.freq.biweekly')}</SelectItem>
                      <SelectItem value="monthly">{t('plannedForm.freq.monthly')}</SelectItem>
                      <SelectItem value="quarterly">{t('plannedForm.freq.quarterly')}</SelectItem>
                      <SelectItem value="yearly">{t('plannedForm.freq.yearly')}</SelectItem>
                      <SelectItem value="custom">{t('plannedForm.freq.custom')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {frequency === "custom" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-custom-days">{t('plannedForm.repeatEvery')}</Label>
                    <Input id="pp-custom-days" type="number" min={1} placeholder={t('plannedForm.customDaysPlaceholder')} value={customDays} onChange={(e) => setCustomDays(e.target.value)} {...fieldErrorProps("pp-custom-days", visibleErrors["pp-custom-days"])} />
                    <FieldError field="pp-custom-days" message={visibleErrors["pp-custom-days"]} />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-end-date">{t('plannedForm.endDate')}</Label>
                    <DatePicker
                      id="pp-end-date"
                      value={endDate}
                      onChange={setEndDate}
                      placeholder={t('plannedForm.freq.none')}
                      allowClear
                      clearLabel={t('common.clear')}
                      buttonClassName="h-9 text-xs"
                      portalContainer={portalContainer}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-max">{t('plannedForm.maxOccurrences')}</Label>
                    <Input id="pp-max" type="number" min={1} placeholder="∞" value={maxOccurrences} onChange={(e) => setMaxOccurrences(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-notes">{t('plannedForm.notes')}</Label>
              <Textarea id="pp-notes" placeholder={t('plannedForm.notesPlaceholder2')} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>

            {/* Optional Link */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-url">{t('plannedForm.link')}</Label>
              <Input id="pp-url" placeholder={t('plannedForm.linkPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('plannedForm.linkDesc')}</p>
            </div>
          </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetErrors(); onOpenChange(false); }}>{t('plannedForm.cancel')}</Button>
          {/* Only the in-flight guard disables this button. Disabling it on the
              empty-required fields made the inline errors unreachable entirely —
              there is no <form> here, so the blocked-submit path is this onClick
              and nothing else could ever reveal them. */}
          <Button onClick={handleSubmit} disabled={loading}>
            {initial ? t('plannedForm.saveChanges') : t('plannedForm.createPayment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
