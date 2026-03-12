import { useState, useEffect } from "react";
import { format } from "date-fns";
import logger from "@/lib/logger";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { apiClient } from "@/lib/api";
import type { Recipient, Category } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";

type Frequency = PlannedPayment["frequency"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Omit<PlannedPayment, "id" | "created_at">) => void;
  initial?: PlannedPayment;
}

// Helper to parse date string in local time (not UTC) to avoid timezone issues
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

export default function PlannedPaymentForm({ open, onOpenChange, onSubmit, initial }: Props) {
  const { t } = useLanguage();
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial?.amount?.toString() ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "EUR");
  const [dueDate, setDueDate] = useState<Date | undefined>(initial?.due_date ? parseLocalDate(initial.due_date) : undefined);
  const [isRecurring, setIsRecurring] = useState(initial?.is_recurring ?? false);
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? "monthly");
  const [customDays, setCustomDays] = useState(initial?.custom_interval_days?.toString() ?? "");
  const [endDate, setEndDate] = useState<Date | undefined>(initial?.end_date ? parseLocalDate(initial.end_date) : undefined);
  const [maxOccurrences, setMaxOccurrences] = useState(initial?.max_occurrences?.toString() ?? "");
  const [recipientId, setRecipientId] = useState<number | undefined>(initial?.recipient_id);
  const [categoryId, setCategoryId] = useState<number | undefined>(initial?.category_id);
  const [bankAccount, setBankAccount] = useState(initial?.bank_account ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (open) {
      const fetchData = async () => {
        try {
          setLoading(true);
          const [recipientsRes, categoriesRes] = await Promise.all([
            apiClient.getRecipients({ limit: 1000, active: true }),
            apiClient.getCategories({ limit: 1000, active: true })
          ]);
          setRecipients(recipientsRes.items);
          setCategories(categoriesRes.items);
        } catch (err) {
          logger.error("Failed to load form data:", err);
        } finally {
          setLoading(false);
        }
      };
      fetchData();
    }
  }, [open]);

  const handleSubmit = () => {
    if (!name.trim() || !amount || !dueDate) {
      alert(t('plannedForm.requiredFieldsHint'));
      return;
    }

    const year = dueDate.getFullYear();
    const month = String(dueDate.getMonth() + 1).padStart(2, '0');
    const day = String(dueDate.getDate()).padStart(2, '0');
    const dueDateStr = `${year}-${month}-${day}`;

    let endDateStr: string | undefined = undefined;
    if (endDate) {
      const eYear = endDate.getFullYear();
      const eMonth = String(endDate.getMonth() + 1).padStart(2, '0');
      const eDay = String(endDate.getDate()).padStart(2, '0');
      endDateStr = `${eYear}-${eMonth}-${eDay}`;
    }

    onSubmit({
      name: name.trim(),
      amount: parseFloat(amount),
      currency,
      due_date: dueDateStr,
      url: url?.trim() || undefined,
      is_recurring: isRecurring,
      recipient_id: recipientId || undefined,
      category_id: categoryId,
      bank_account: bankAccount || undefined,
      notes: notes || undefined,
      ...(isRecurring && {
        frequency,
        ...(frequency === "custom" && customDays ? { custom_interval_days: parseInt(customDays) } : {}),
        ...(endDateStr ? { end_date: endDateStr } : {}),
        ...(maxOccurrences ? { max_occurrences: parseInt(maxOccurrences) } : {}),
      }),
      is_active: initial?.is_active ?? true,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t('plannedForm.editTitle') : t('plannedForm.newTitle')}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
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
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("justify-start text-left font-normal", !dueDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dueDate ? format(dueDate, "PPP") : t('plannedForm.pickDate')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>

            {/* Recipient */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-recipient">{t('plannedForm.recipient')}</Label>
              <Select value={recipientId != null ? String(recipientId) : "none"} onValueChange={(v) => setRecipientId(v === "none" ? undefined : parseInt(v))}>
                <SelectTrigger id="pp-recipient">
                  <SelectValue placeholder={t('plannedForm.recipientOptional')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('plannedForm.freq.none')}</SelectItem>
                  {recipients.map((r) => (
                    <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Category */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-category">{t('plannedForm.category')}</Label>
              <Select value={categoryId?.toString() ?? "none"} onValueChange={(v) => setCategoryId(v === "none" ? undefined : parseInt(v))}>
                <SelectTrigger id="pp-category">
                  <SelectValue placeholder={t('plannedForm.categoryOptional')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('plannedForm.freq.none')}</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()}>
                      {c.general}:{c.detail}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Bank account */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-bank">{t('plannedForm.bankAccount')}</Label>
              <Input id="pp-bank" placeholder={t('plannedForm.bankPlaceholder')} value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
            </div>

            {/* Recurring toggle */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="pp-recurring" className="font-medium">{t('plannedForm.recurring')}</Label>
                <p className="text-xs text-muted-foreground">{t('plannedForm.recurringDesc')}</p>
              </div>
              <Switch id="pp-recurring" checked={isRecurring} onCheckedChange={setIsRecurring} />
            </div>

            {/* Recurring options */}
            {isRecurring && (
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
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn("justify-start text-left font-normal text-xs", !endDate && "text-muted-foreground")}>
                          <CalendarIcon className="mr-1 h-3 w-3" />
                          {endDate ? format(endDate, "PP") : t('plannedForm.freq.none')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={endDate} onSelect={setEndDate} initialFocus className={cn("p-3 pointer-events-auto")} />
                      </PopoverContent>
                    </Popover>
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
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('plannedForm.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={loading || !name.trim() || !amount || !dueDate}>
            {initial ? t('plannedForm.saveChanges') : t('plannedForm.createPayment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
