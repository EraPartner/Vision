/**
 * MarkAsFiledDialog
 *
 * Collects an optional filing reference (Tax-on-Web id, paper return code, etc.) and
 * marks a year as filed. Filing also freezes the calculation — see ADR-059 §filing.
 *
 * Reference is free-text and stored verbatim. Empty reference is permitted.
 *
 * A year can be filed when it is the live year, has its own household snapshot, or has an
 * explicitly frozen calculation. A past year that would only use a live estimate is not eligible.
 * Filing the live year pins its household as that year's snapshot, so later edits no longer
 * change the filed inputs. A frozen year is filed as it is: pinning today's live household there
 * would record inputs that disagree with the frozen figures. The filing is shown only after the
 * household, snapshot and frozen metadata are saved together.
 */
import { persistTaxFiling } from "@/stores/taxPersistence";
import { useState, type ReactNode } from "react";
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
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { hasMeaningfulBelgianTaxData } from "@/stores/belgianTaxStore";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";

interface MarkAsFiledDialogProps {
    trigger: ReactNode;
    year: number;
}

export function MarkAsFiledDialog({ trigger, year }: MarkAsFiledDialogProps) {
    const { t } = useLanguage();
    const ready = useBelgianTaxProfile(
        (state) =>
            !state.isLoading &&
            !state.householdLoadFailed &&
            state.household != null &&
            (year === state.household.taxYear ||
                Object.hasOwn(state.householdSnapshots, year) ||
                Boolean(state.snapshotMetas[year]?.frozenCalculation)) &&
            hasMeaningfulBelgianTaxData(state.profileForYear(year)),
    );
    const [open, setOpen] = useState(false);
    const [reference, setReference] = useState("");

    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);

    async function handleConfirm(e: React.FormEvent) {
        e.preventDefault();
        if (!ready || saving) return;
        const trimmed = reference.trim();
        setSaving(true);
        setSaveFailed(false);
        try {
            await persistTaxFiling(
                year,
                trimmed.length > 0 ? trimmed : undefined,
            );
            setOpen(false);
            setReference("");
        } catch {
            setSaveFailed(true);
        } finally {
            setSaving(false);
        }
    }

    function handleOpenChange(o: boolean) {
        if (saving) return;
        setOpen(o);
        if (!o) setReference("");
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t("tax.markFiled.title", { year: String(year) })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("tax.markFiled.description")}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter in the reference field confirms (filing is
                    reversible — see unmarkYearAsFiled). grid gap-5 mirrors
                    DialogContent's layout, so this wrapper is layout-neutral. */}
                {!ready && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("tax.markFiled.prerequisite")}
                    </p>
                )}
                {saveFailed && <p role="alert">{t("settings.saveFailed")}</p>}
                <form onSubmit={handleConfirm} className="grid gap-5">
                    <div className="space-y-2">
                        <Label htmlFor="filing-reference">
                            {t("tax.markFiled.referenceLabel")}
                        </Label>
                        <Input
                            id="filing-reference"
                            disabled={saving}
                            value={reference}
                            onChange={(e) => setReference(e.target.value)}
                            placeholder={t(
                                "tax.markFiled.referencePlaceholder",
                            )}
                        />
                        <p className="type-footnote text-label-secondary">
                            {t("tax.markFiled.referenceHelp")}
                        </p>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            disabled={saving}
                            variant="outline"
                            onClick={() => handleOpenChange(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={!ready || saving}>
                            {t("tax.markFiled.confirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
