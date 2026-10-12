import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    ACTIVITY_KINDS,
    PENSION_KINDS,
    type ActivityKind,
    type ForfaitCategory,
    type HouseholdPartner,
    type IncomeActivity,
    type PensionKind,
} from "@/lib/belgianTax/householdTypes";
import type { ProfessionalExpenseMethod } from "@/lib/belgianTax";
import type { PartnerStepProps } from "./types";
import { ProfileNumberField } from "./ProfileNumberField";
import { PartnerSwitcher } from "./PartnerSwitcher";
import {
    type ActivityPatch,
    addActivity,
    expenseCategories,
    findPartner,
    partnerLabel,
    removeActivity,
    updateActivity,
    updatePartner,
} from "./householdEditing";
import {
    ChoiceGroup,
    ChoiceRow,
    FieldHint,
    StepIntro,
    ToggleGroup,
    ToggleRow,
} from "./ProfileRows";

const groupSurfaceClass =
    "space-y-3 rounded-card corner-continuous border border-border/60 bg-card/70 p-4";

function OptionalBadge() {
    const { t } = useLanguage();
    return (
        <Badge variant="outline" size="sm" className="ml-1">
            {t("common.optional")}
        </Badge>
    );
}

function dateValue(iso: string | undefined): Date | undefined {
    if (!iso) return undefined;
    const date = parseLocalDateFromYmd(iso);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

interface ActivityEditorProps {
    activity: IncomeActivity;
    index: number;
    canRemove: boolean;
    onChange: (patch: ActivityPatch) => void;
    onRemove: () => void;
    portalContainer?: HTMLElement | null | undefined;
}

function ActivityEditor({
    activity,
    index,
    canRemove,
    onChange,
    onRemove,
    portalContainer,
}: ActivityEditorProps) {
    const { t } = useLanguage();
    const isNet = activity.kind === "net_professional_amount";
    const id = activity.id;
    return (
        <div className={groupSurfaceClass}>
            <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor={`${id}-kind`}>
                        {t("tax.household.activity.kindLabel", {
                            n: index + 1,
                        })}
                    </Label>
                    <Select
                        value={activity.kind}
                        onValueChange={(kind) =>
                            onChange({ kind: kind as ActivityKind })
                        }
                    >
                        <SelectTrigger id={`${id}-kind`} className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {ACTIVITY_KINDS.map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                    {t(`tax.household.activity.kind.${kind}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {canRemove && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={onRemove}
                        aria-label={t("tax.household.activity.remove", {
                            n: index + 1,
                        })}
                    >
                        <Trash2 aria-hidden="true" />
                    </Button>
                )}
            </div>
            <FieldHint>{t(`tax.household.activity.kind.${activity.kind}.desc`)}</FieldHint>

            {activity.kind === "pension" && (
                <div className="space-y-2">
                    <Label htmlFor={`${id}-pension-kind`}>
                        {t("tax.household.activity.pensionKind")}
                    </Label>
                    <Select
                        value={activity.pensionKind ?? ""}
                        onValueChange={(pensionKind) =>
                            onChange({ pensionKind: pensionKind as PensionKind })
                        }
                    >
                        <SelectTrigger id={`${id}-pension-kind`} className="w-full">
                            <SelectValue
                                placeholder={t("tax.household.activity.pensionKind.placeholder")}
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {PENSION_KINDS.map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                    {t(`tax.household.activity.pensionKind.${kind}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FieldHint>
                        {t("tax.household.activity.pensionKind.desc")}
                        {activity.pensionKind &&
                            ` ${t(`tax.household.activity.pensionKind.${activity.pensionKind}.desc`)}`}
                    </FieldHint>
                </div>
            )}

            {isNet ? (
                <ProfileNumberField
                    id={`${id}-net`}
                    label={t("tax.household.activity.netIncome")}
                    min={0}
                    step={100}
                    value={activity.netProfessionalIncome ?? 0}
                    onValueChange={(value) =>
                        onChange({ netProfessionalIncome: value ?? 0 })
                    }
                />
            ) : (
                <ProfileNumberField
                    id={`${id}-gross`}
                    label={t("tax.profile.field.grossAnnualIncome")}
                    description={
                        index === 0
                            ? t("tax.profile.field.grossAnnualIncome.desc")
                            : undefined
                    }
                    min={0}
                    step={100}
                    value={activity.grossIncome}
                    onValueChange={(value) =>
                        onChange({ grossIncome: value ?? 0 })
                    }
                    placeholder={t("tax.profile.placeholder.grossIncome")}
                />
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`${id}-start`}>
                        {t("tax.household.activity.startDate")}
                        <OptionalBadge />
                    </Label>
                    <DatePicker
                        id={`${id}-start`}
                        value={dateValue(activity.startDate)}
                        onChange={(date) =>
                            onChange({ startDate: date ? toYmd(date) : undefined })
                        }
                        placeholder={t("tax.household.activity.wholeYear")}
                        allowClear
                        clearLabel={t("common.clear")}
                        portalContainer={portalContainer}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${id}-end`}>
                        {t("tax.household.activity.endDate")}
                        <OptionalBadge />
                    </Label>
                    <DatePicker
                        id={`${id}-end`}
                        value={dateValue(activity.endDate)}
                        onChange={(date) =>
                            onChange({ endDate: date ? toYmd(date) : undefined })
                        }
                        placeholder={t("tax.household.activity.wholeYear")}
                        allowClear
                        clearLabel={t("common.clear")}
                        portalContainer={portalContainer}
                    />
                </div>
            </div>
        </div>
    );
}

interface ExpenseChoiceEditorProps {
    partner: HouseholdPartner;
    category: ForfaitCategory;
    showCategory: boolean;
    onChange: (method: ProfessionalExpenseMethod, actualAmount: number) => void;
}

function ExpenseChoiceEditor({
    partner,
    category,
    showCategory,
    onChange,
}: ExpenseChoiceEditorProps) {
    const { t } = useLanguage();
    const choice = partner.professionalExpenses[category];
    const method = choice?.method ?? "lump_sum";
    const actualAmount = choice?.actualAmount ?? 0;
    const prefix = `exp-${partner.id}-${category}`;
    return (
        <div className="space-y-3">
            {showCategory && (
                <p className="type-body font-medium text-foreground">
                    {t(`tax.household.expenseCategory.${category}`)}
                </p>
            )}
            <ChoiceGroup
                aria-label={
                    showCategory
                        ? t(`tax.household.expenseCategory.${category}`)
                        : t("tax.profile.section.professionalExpenses.title")
                }
                value={method}
                onValueChange={(v) =>
                    onChange(v as ProfessionalExpenseMethod, actualAmount)
                }
            >
                <ChoiceRow
                    id={`${prefix}-lump`}
                    value="lump_sum"
                    checked={method === "lump_sum"}
                    label={t("tax.profile.profExp.lump.label")}
                    description={t("tax.profile.profExp.lump.desc")}
                />
                <ChoiceRow
                    id={`${prefix}-actual`}
                    value="actual"
                    checked={method === "actual"}
                    label={t("tax.profile.profExp.actual.label")}
                    description={t("tax.profile.profExp.actual.desc")}
                />
            </ChoiceGroup>
            {method === "actual" && (
                <ProfileNumberField
                    id={`${prefix}-amount`}
                    containerClassName="space-y-2 pt-1"
                    label={t("tax.profile.field.actualProfessionalExpenses")}
                    min={0}
                    step={100}
                    value={actualAmount}
                    onValueChange={(value) => onChange(method, value ?? 0)}
                    placeholder={t("tax.profile.placeholder.actualExpenses")}
                />
            )}
        </div>
    );
}

/**
 * Income step: the professional activities of each partner (kind, amount, period), the
 * expense method per forfait category, and the partner's other income, alimony, union dues,
 * birth year and disability (ADR-200).
 */
export function IncomeStep({
    household,
    updateHousehold,
    partnerId,
    onPartnerChange,
    portalContainer,
}: PartnerStepProps) {
    const { t } = useLanguage();
    const partner = findPartner(household, partnerId);
    if (!partner) return null;
    const pid = partner.id;
    const categories = expenseCategories(partner);
    const editPartner = (
        patch: Partial<Omit<HouseholdPartner, "id" | "activities">>,
    ) =>
        updateHousehold((h) =>
            updatePartner(h, pid, (p) => ({ ...p, ...patch })),
        );

    return (
        <div className="space-y-5" key={pid}>
            <StepIntro
                title={t("tax.profile.section.income.title")}
                description={t("tax.profile.section.income.desc")}
            />
            <PartnerSwitcher
                household={household}
                value={pid}
                onValueChange={onPartnerChange}
            />

            <div className="space-y-3">
                <StepIntro
                    title={t("tax.household.activities.title", {
                        partner: partnerLabel(t, partner),
                    })}
                    description={t("tax.household.activities.desc")}
                />
                {partner.activities.map((activity, index) => (
                    <ActivityEditor
                        key={activity.id}
                        activity={activity}
                        index={index}
                        canRemove={pid === "B" || partner.activities.length > 1}
                        onChange={(patch) =>
                            updateHousehold((h) =>
                                updateActivity(h, pid, activity.id, patch),
                            )
                        }
                        onRemove={() =>
                            updateHousehold((h) =>
                                removeActivity(h, pid, activity.id),
                            )
                        }
                        portalContainer={portalContainer}
                    />
                ))}
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateHousehold((h) => addActivity(h, pid))}
                >
                    <Plus aria-hidden="true" />
                    {t("tax.household.activity.add")}
                </Button>
            </div>

            {categories.length > 0 && (
                <>
                    <Separator />
                    <div className="space-y-3">
                        <StepIntro
                            title={t(
                                "tax.profile.section.professionalExpenses.title",
                            )}
                            description={t(
                                "tax.profile.section.professionalExpenses.desc",
                            )}
                        />
                        {categories.map((category) => (
                            <ExpenseChoiceEditor
                                key={category}
                                partner={partner}
                                category={category}
                                showCategory={categories.length > 1}
                                onChange={(method, actualAmount) =>
                                    // Merge into the updater's partner, not the render-time one,
                                    // so queued changes in other categories are kept.
                                    updateHousehold((h) =>
                                        updatePartner(h, pid, (p) => ({
                                            ...p,
                                            professionalExpenses: {
                                                ...p.professionalExpenses,
                                                [category]: { method, actualAmount },
                                            },
                                        })),
                                    )
                                }
                            />
                        ))}
                    </div>
                </>
            )}

            <Separator />

            <ProfileNumberField
                id={`other-income-${pid}`}
                label={
                    <>
                        {t("tax.profile.field.otherTaxableIncome")}
                        <OptionalBadge />
                    </>
                }
                description={t("tax.profile.field.otherTaxableIncome.desc")}
                min={0}
                step={100}
                value={partner.otherTaxableIncome}
                onValueChange={(value) =>
                    editPartner({ otherTaxableIncome: value ?? 0 })
                }
                placeholder={t("tax.profile.placeholder.otherIncome")}
            />
            <ProfileNumberField
                id={`alimony-${pid}`}
                label={t("tax.profile.field.alimonyPaid")}
                min={0}
                step={10}
                value={partner.alimonyPaid}
                onValueChange={(value) => editPartner({ alimonyPaid: value ?? 0 })}
                placeholder={t("tax.profile.placeholder.alimonyPaid")}
            />
            <ProfileNumberField
                id={`union-${pid}`}
                label={t("tax.profile.field.unionDues")}
                description={t("tax.profile.field.unionDues.desc")}
                min={0}
                step={10}
                value={partner.unionDues}
                onValueChange={(value) => editPartner({ unionDues: value ?? 0 })}
                placeholder={t("tax.profile.placeholder.unionDues")}
            />
            <ProfileNumberField
                id={`birth-year-${pid}`}
                label={
                    <>
                        {t("tax.household.field.birthYear")}
                        <OptionalBadge />
                    </>
                }
                description={t("tax.household.field.birthYear.desc")}
                min={1900}
                max={household.taxYear}
                step={1}
                integer
                allowEmpty
                value={partner.birthYear}
                onValueChange={(value) =>
                    updateHousehold((h) =>
                        updatePartner(h, pid, (p) => {
                            const { birthYear: _old, ...rest } = p;
                            return value !== undefined &&
                                value >= 1900 &&
                                value <= 2200
                                ? { ...rest, birthYear: value }
                                : rest;
                        }),
                    )
                }
                className="w-32"
            />

            <ToggleGroup>
                <ToggleRow
                    id={`disabled-${pid}`}
                    label={t("tax.household.field.disability", {
                        partner: partnerLabel(t, partner),
                    })}
                    description={t("tax.profile.field.disabilityExemption.desc")}
                    checked={partner.isDisabled}
                    onCheckedChange={(v) => editPartner({ isDisabled: v })}
                />
            </ToggleGroup>
        </div>
    );
}
