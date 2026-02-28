import { useState, useEffect } from "react";
import { format } from "date-fns";
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
          console.error("Failed to load form data:", err);
        } finally {
          setLoading(false);
        }
      };
      fetchData();
    }
  }, [open]);

  const handleSubmit = () => {
    if (!name.trim() || !amount || !dueDate || !recipientId) {
      alert("Please fill in all required fields (Name, Amount, Due Date, and Recipient)");
      return;
    }
    
    const year = dueDate.getFullYear();
    const month = String(dueDate.getMonth() + 1).padStart(2, '0');
    const day = String(dueDate.getDate()).padStart(2, '0');
    const dueDateStr = `${year}-${month}-${day}`;

    // Compute endDateStr only if an end date was selected (optional)
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
      recipient_id: recipientId,
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
          <DialogTitle>{initial ? "Edit Payment" : "New Planned Payment"}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            {/* Name */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-name">Name *</Label>
              <Input id="pp-name" placeholder="e.g. Rent, Netflix…" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {/* Amount + Currency */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="pp-amount">Amount *</Label>
                <Input id="pp-amount" type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pp-currency">Currency</Label>
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
              <Label>Due Date *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("justify-start text-left font-normal", !dueDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dueDate ? format(dueDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>

            {/* Recipient (Required) */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-recipient">Recipient *</Label>
              <Select value={recipientId?.toString()} onValueChange={(v) => setRecipientId(parseInt(v))}>
                <SelectTrigger id="pp-recipient">
                  <SelectValue placeholder="Select a recipient" />
                </SelectTrigger>
                <SelectContent>
                  {recipients.map((r) => (
                    <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Category */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-category">Category</Label>
              <Select value={categoryId?.toString() ?? "none"} onValueChange={(v) => setCategoryId(v === "none" ? undefined : parseInt(v))}>
                <SelectTrigger id="pp-category">
                  <SelectValue placeholder="Select a category (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
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
              <Label htmlFor="pp-bank">Bank Account</Label>
              <Input id="pp-bank" placeholder="e.g. Main checking" value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
            </div>

            {/* Recurring toggle */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="pp-recurring" className="font-medium">Recurring</Label>
                <p className="text-xs text-muted-foreground">Repeats on a schedule</p>
              </div>
              <Switch id="pp-recurring" checked={isRecurring} onCheckedChange={setIsRecurring} />
            </div>

            {/* Recurring options */}
            {isRecurring && (
              <div className="grid gap-3 rounded-lg border p-3 bg-muted/30">
                <div className="grid gap-1.5">
                  <Label>Frequency</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                      <SelectItem value="custom">Custom interval</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {frequency === "custom" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-custom-days">Repeat every N days</Label>
                    <Input id="pp-custom-days" type="number" min={1} placeholder="e.g. 10" value={customDays} onChange={(e) => setCustomDays(e.target.value)} />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>End Date</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn("justify-start text-left font-normal text-xs", !endDate && "text-muted-foreground")}>
                          <CalendarIcon className="mr-1 h-3 w-3" />
                          {endDate ? format(endDate, "PP") : "None"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={endDate} onSelect={setEndDate} initialFocus className={cn("p-3 pointer-events-auto")} />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="pp-max">Max occurrences</Label>
                    <Input id="pp-max" type="number" min={1} placeholder="∞" value={maxOccurrences} onChange={(e) => setMaxOccurrences(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-notes">Notes</Label>
              <Textarea id="pp-notes" placeholder="Any additional details…" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>

            {/* Optional Link */}
            <div className="grid gap-1.5">
              <Label htmlFor="pp-url">Link (optional)</Label>
              <Input id="pp-url" placeholder="https://example.com/invoice/123" value={url} onChange={(e) => setUrl(e.target.value)} />
              <p className="text-xs text-muted-foreground">An optional https:// or http:// URL related to this planned expense.</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading || !name.trim() || !amount || !dueDate || !recipientId}>
            {initial ? "Save Changes" : "Create Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}