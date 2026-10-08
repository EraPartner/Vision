import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Loader2 } from "lucide-react";
import { useCreateRecipient } from "@/hooks/useRecipients";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export function AddRecipientDialog() {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const createMutation = useCreateRecipient();
    const [form, setForm] = useState({ name: "", notes: "" });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!form.name.trim()) {
            (e.currentTarget as HTMLFormElement)
                .querySelector<HTMLInputElement>("#name")
                ?.focus();
            return;
        }

        createMutation.mutate(
            {
                name: form.name.trim(),
                notes: form.notes.trim() || undefined,
            },
            {
                onSuccess: () => {
                    setSubmitted(false);
                    setForm({ name: "", notes: "" });
                    setOpen(false);
                },
            },
        );
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setSubmitted(false);
                setOpen(next);
            }}
        >
            <DialogTrigger asChild>
                <Button>
                    <Plus aria-hidden="true" />
                    {t("form.addRecipient.title")}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("form.addRecipient.title")}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("form.addRecipient.title")}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="name">
                            {t("form.addRecipient.name")}
                        </Label>
                        <Input
                            aria-invalid={submitted && !form.name.trim()}
                            aria-describedby={
                                submitted && !form.name.trim()
                                    ? "recipient-name-error"
                                    : undefined
                            }
                            id="name"
                            placeholder={t("addRec.namePlaceholder")}
                            maxLength={200}
                            value={form.name}
                            onChange={(e) =>
                                setForm((f) => ({ ...f, name: e.target.value }))
                            }
                            required
                        />
                        {submitted && !form.name.trim() && (
                            <p
                                id="recipient-name-error"
                                role="alert"
                                className="type-footnote text-destructive"
                            >
                                {t("form.nameRequired")}
                            </p>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="notes">
                            {t("addRec.notesOptional")}
                        </Label>
                        <Textarea
                            id="notes"
                            placeholder={t("addRec.notesPlaceholder")}
                            maxLength={1000}
                            value={form.notes}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    notes: e.target.value,
                                }))
                            }
                        />
                    </div>
                    <DialogFooter className="pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={createMutation.isPending}
                        >
                            {createMutation.isPending && (
                                <Loader2
                                    className="animate-spin"
                                    aria-hidden="true"
                                />
                            )}
                            {t("recipients.createButton")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
