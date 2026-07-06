import { useState } from "react";
import { parseDecimal } from "@/lib/decimal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { DatePicker } from "@/components/shared/DatePicker";
import { TagInput } from "@/components/shared/TagInput";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";

type Frequency = PlannedPayment["frequency"];
type LoanType = NonNullable<PlannedPayment["loan_type"]>;

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
  const [amount, setAmount] = useState(initial?.amount?.toString() ?? "");
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

  const handleSubmit = () => {
    if (!name.trim() || !dueDate || (!isLoan && !amount) || !bankAccount.trim()) {
      alert(t('plannedForm.requiredFieldsHint'));
      return;
    }

    if (isLoan) {
      if (!loanPrincipal || !loanRate || !loanTermMonths) {
        alert(t('plannedForm.loanRequiredHint'));
        return;
      }
      const term = parseInt(loanTermMonths, 10);
      if (!Number.isInteger(term) || term < 1 || term > 600) {
        alert(t('plannedForm.loanTermInvalid'));
        return;
      }
    }

    const dueDateStr = toYmd(dueDate);

    let endDateStr: string | undefined = undefined;
    if (endDate) {
      endDateStr = toYmd(endDate);
    }

    // If loan is enabled, clear recurrence inputs before submitting - loans drive their own schedule
    const payload: Record<string, unknown> = {
      name: name.trim(),
      amount: parseDecimal(amount),
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
        ...(endDateStr ? { end_date: endDateStr } : {}),
        ...(maxOccurrences ? { max_occurrences: parseInt(maxOccurrences) } : {}),
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
              <Input id="pp-name" placeholder={t('plannedForm.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {/* Amount + Currency */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="pp-amount">{t('plannedForm.amountRequired2')}</Label>
                <Input id="pp-amount" type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
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

            {/* Due date */}
            <div className="grid gap-1.5">
              <Label>{t('plannedForm.dueDate')}</Label>
              <DatePicker
                value={dueDate}
                onChange={setDueDate}
                placeholder={t('plannedForm.pickDate')}
                portalContainer={portalContainer}
              />
            </div>

            {/* Recipient */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-recipient">{t('plannedForm.recipient')}</Label>
              <RecipientCombobox
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
                value={categoryId ?? null}
                onSelect={(id) => setCategoryId(id ?? undefined)}
                className="w-full"
                disabled={loading}
                portalContainer={portalContainer}
              />
            </div>

            {/* Tags */}
            <div className="grid gap-1.5">
              <Label>{t('txPage.field.tags')}</Label>
              <TagInput value={tags} onChange={setTags} />
            </div>

            {/* Bank account */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-bank">{t('plannedForm.bankAccountRequired')}</Label>
              <Input id="pp-bank" placeholder={t('plannedForm.bankPlaceholder')} value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
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
                  <Label>{t('plannedForm.loanType')}</Label>
                  <Select value={loanType} onValueChange={(v) => setLoanType(v as LoanType)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
                    <Input id="pp-loan-principal" type="number" step="0.01" min={0.01} value={loanPrincipal} onChange={(e) => setLoanPrincipal(e.target.value)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-rate">{t('plannedForm.loanRate')}</Label>
                    <Input id="pp-loan-rate" type="number" step="0.01" min={0} max={100} value={loanRate} onChange={(e) => setLoanRate(e.target.value)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-loan-term">{t('plannedForm.loanTermMonths')}</Label>
                    <Input id="pp-loan-term" type="number" min={1} value={loanTermMonths} onChange={(e) => setLoanTermMonths(e.target.value)} />
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
                  <Label>{t('plannedForm.frequency')}</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
                    <Input id="pp-custom-days" type="number" min={1} placeholder={t('plannedForm.customDaysPlaceholder')} value={customDays} onChange={(e) => setCustomDays(e.target.value)} />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>{t('plannedForm.endDate')}</Label>
                    <DatePicker
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('plannedForm.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={loading || !name.trim() || !dueDate || (!isLoan && !amount) || !bankAccount.trim()}>
            {initial ? t('plannedForm.saveChanges') : t('plannedForm.createPayment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
