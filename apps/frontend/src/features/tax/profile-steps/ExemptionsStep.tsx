import { enumGuard, onGuarded } from "@/lib/enumGuard";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { PartnerReductionInputs } from "@/lib/belgianTax/householdTypes";
import type { PartnerStepProps, StepProps } from "./types";
import { PartnerSwitcher } from "./PartnerSwitcher";
import { findPartner, updatePartner } from "./householdEditing";
import { ProfileNumberInput } from "./ProfileNumberInput";
import { BoundedCountSelect } from "./ProfileSelectFields";
import { FieldHint, StepIntro, ToggleGroup, ToggleRow } from "./ProfileRows";

interface EligibilitySwitchProps {
    id: string;
    label: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}

/** Inline "this item qualifies" switch under a deduction amount. */
type PensionScheme = "1050" | "1350";
const isPensionScheme = enumGuard<PensionScheme>({ "1050": true, "1350": true });

function EligibilitySwitch({
    id,
    label,
    checked,
    onCheckedChange,
}: EligibilitySwitchProps) {
    return (
        <div className="flex items-center gap-3">
            <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
            <Label htmlFor={id} className="font-normal">
                {label}
            </Label>
        </div>
    );
}

function OptionalBadge() {
    const { t } = useLanguage();
    return (
        <Badge variant="outline" size="sm" className="ml-1">
            {t("common.optional")}
        </Badge>
    );
}

/**
 * Exemptions step: dependants (household level, through the v1 projection) and the tax
 * reductions and isolated-parent request of each partner (ADR-200).
 */
export function ExemptionsStep({
    profile,
    updateProfile,
    household,
    updateHousehold,
    partnerId,
    onPartnerChange,
}: StepProps & PartnerStepProps) {
    const { t } = useLanguage();
    const partner = findPartner(household, partnerId);
    if (!partner) return null;
    const pid = partner.id;
    const r = partner.reductions;
    const setReductions = (patch: Partial<PartnerReductionInputs>) =>
        updateHousehold((h) =>
            updatePartner(h, pid, (p) => ({
                ...p,
                reductions: { ...p.reductions, ...patch },
            })),
        );
    return (
        <div className="space-y-5">
            <StepIntro
                title={t("tax.profile.section.exemptions.title")}
                description={t("tax.profile.section.exemptions.desc")}
            />

            <div className="space-y-2">
                <Label htmlFor="dep-children">
                    {t("tax.profile.field.children")}
                </Label>
                <FieldHint>
                    {t("tax.profile.dependents.children.desc")}
                </FieldHint>
                <BoundedCountSelect
                    id="dep-children"
                    value={profile.dependentChildren}
                    max={5}
                    onValueChange={(next) => {
                        const disabled = Math.min(
                            profile.dependentChildrenDisabled ?? 0,
                            next,
                        );
                        updateProfile({
                            dependentChildren: next,
                            dependentChildrenDisabled: disabled,
                        });
                    }}
                    renderOption={(n) =>
                        n === 0
                            ? t("common.none")
                            : n === 1
                              ? `${n} ${t("tax.profile.field.children.singular")}`
                              : `${n} ${t("tax.profile.field.children")}`
                    }
                />
            </div>

            {profile.dependentChildren > 0 && (
                <div className="space-y-2 border-l-2 border-border/60 pl-3">
                    <Label htmlFor="dep-children-disabled">
                        {t("tax.profile.field.childrenDisabled")}
                        <OptionalBadge />
                    </Label>
                    <FieldHint>
                        {t("tax.profile.field.childrenDisabled.desc")}
                    </FieldHint>
                    <BoundedCountSelect
                        id="dep-children-disabled"
                        value={profile.dependentChildrenDisabled ?? 0}
                        max={profile.dependentChildren}
                        onValueChange={(value) =>
                            updateProfile({ dependentChildrenDisabled: value })
                        }
                        renderOption={(n) =>
                            n === 0 ? t("common.none") : String(n)
                        }
                    />
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor="dep-other">
                    {t("tax.profile.field.others")}
                    <OptionalBadge />
                </Label>
                <FieldHint>{t("tax.profile.dependents.others.desc")}</FieldHint>
                <BoundedCountSelect
                    id="dep-other"
                    value={profile.dependentOtherPersons}
                    max={3}
                    onValueChange={(next) => {
                        const disabled = Math.min(
                            profile.dependentOtherPersonsDisabled ?? 0,
                            next,
                        );
                        updateProfile({
                            dependentOtherPersons: next,
                            dependentOtherPersonsDisabled: disabled,
                        });
                    }}
                    renderOption={(n) =>
                        n === 0
                            ? t("common.none")
                            : n === 1
                              ? `${n} ${t("tax.profile.field.others.singular")}`
                              : `${n} ${t("tax.profile.field.others")}`
                    }
                />
            </div>

            {profile.dependentOtherPersons > 0 && (
                <div className="space-y-2 border-l-2 border-border/60 pl-3">
                    <Label htmlFor="dep-other-disabled">
                        {t("tax.profile.field.othersDisabled")}
                        <OptionalBadge />
                    </Label>
                    <FieldHint>
                        {t("tax.profile.field.othersDisabled.desc")}
                    </FieldHint>
                    <BoundedCountSelect
                        id="dep-other-disabled"
                        value={profile.dependentOtherPersonsDisabled ?? 0}
                        max={profile.dependentOtherPersons}
                        onValueChange={(value) =>
                            updateProfile({
                                dependentOtherPersonsDisabled: value,
                            })
                        }
                        renderOption={(n) =>
                            n === 0 ? t("common.none") : String(n)
                        }
                    />
                </div>
            )}

            <Separator />

            <StepIntro
                title={t("tax.profile.section.otherDeductions.title")}
                description={t("tax.profile.section.otherDeductions.desc")}
            />
            <PartnerSwitcher
                household={household}
                value={pid}
                onValueChange={onPartnerChange}
            />

            <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                    <Label htmlFor={`pension-${pid}`}>
                        {t("tax.profile.field.personalPensionContributions")}
                    </Label>
                    <ProfileNumberInput
                        id={`pension-${pid}`}
                        min={0}
                        step={10}
                        value={r.personalPensionContributions}
                        onValueChange={(value) =>
                            setReductions({
                                personalPensionContributions: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.personalPensionContributions",
                        )}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <Select
                            {...(r.pensionScheme === undefined
                                ? {}
                                : { value: r.pensionScheme })}
                            onValueChange={onGuarded(
                                isPensionScheme,
                                (pensionScheme) =>
                                    setReductions({ pensionScheme }),
                            )}
                        >
                            <SelectTrigger id={`pension-scheme-${pid}`} className="w-56">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="1050">
                                    {t("tax.profile.pensionScheme.standard")}
                                </SelectItem>
                                <SelectItem value="1350">
                                    {t("tax.profile.pensionScheme.alternative")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <EligibilitySwitch
                            id={`pension-eligible-${pid}`}
                            checked={!!r.pensionEligible}
                            onCheckedChange={(v) =>
                                setReductions({ pensionEligible: v })
                            }
                            label={t("tax.profile.flag.pensionEligible")}
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`group-insurance-${pid}`}>
                        {t(
                            "tax.profile.field.employeeGroupInsuranceContributions",
                        )}
                    </Label>
                    <ProfileNumberInput
                        id={`group-insurance-${pid}`}
                        min={0}
                        step={10}
                        value={r.employeeGroupInsuranceContributions}
                        onValueChange={(value) =>
                            setReductions({
                                employeeGroupInsuranceContributions: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.employeeGroupInsuranceContributions",
                        )}
                    />
                    <EligibilitySwitch
                        id={`group-insurance-eligible-${pid}`}
                        checked={!!r.employeeGroupInsuranceEligible}
                        onCheckedChange={(v) =>
                            setReductions({
                                employeeGroupInsuranceEligible: v,
                            })
                        }
                        label={t(
                            "tax.profile.flag.employeeGroupInsuranceEligible",
                        )}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`life-${pid}`}>
                        {t("tax.profile.field.lifeInsurancePremiums")}
                    </Label>
                    <ProfileNumberInput
                        id={`life-${pid}`}
                        min={0}
                        step={10}
                        value={r.lifeInsurancePremiums}
                        onValueChange={(value) =>
                            setReductions({ lifeInsurancePremiums: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.lifeInsurancePremiums",
                        )}
                    />
                    <EligibilitySwitch
                        id={`life-eligible-${pid}`}
                        checked={!!r.lifeInsuranceEligible}
                        onCheckedChange={(v) =>
                            setReductions({ lifeInsuranceEligible: v })
                        }
                        label={t("tax.profile.flag.lifeInsuranceEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`donations-${pid}`}>
                        {t("tax.profile.field.charitableDonations")}
                    </Label>
                    <ProfileNumberInput
                        id={`donations-${pid}`}
                        min={0}
                        step={10}
                        value={r.charitableDonations}
                        onValueChange={(value) =>
                            setReductions({ charitableDonations: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.charitableDonations",
                        )}
                    />
                    <EligibilitySwitch
                        id={`donations-eligible-${pid}`}
                        checked={!!r.charitableDonationsEligible}
                        onCheckedChange={(v) =>
                            setReductions({
                                charitableDonationsEligible: v,
                            })
                        }
                        label={t(
                            "tax.profile.flag.charitableDonationsEligible",
                        )}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`childcare-${pid}`}>
                        {t("tax.profile.field.childcareCosts")}
                    </Label>
                    <ProfileNumberInput
                        id={`childcare-${pid}`}
                        min={0}
                        step={10}
                        value={r.childcareCosts}
                        onValueChange={(value) =>
                            setReductions({ childcareCosts: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.childcareCosts",
                        )}
                    />
                    <Label htmlFor={`childcare-days-${pid}`}>
                        {t("tax.profile.field.childcareEligibleDays")}
                    </Label>
                    <ProfileNumberInput
                        id={`childcare-days-${pid}`}
                        min={0}
                        step={1}
                        integer
                        value={r.childcareEligibleDays}
                        onValueChange={(value) =>
                            setReductions({
                                childcareEligibleDays: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.childcareEligibleDays",
                        )}
                    />
                    <EligibilitySwitch
                        id={`childcare-eligible-${pid}`}
                        checked={!!r.childcareEligible}
                        onCheckedChange={(v) =>
                            setReductions({ childcareEligible: v })
                        }
                        label={t("tax.profile.flag.childcareEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`domestic-help-${pid}`}>
                        {t("tax.profile.field.domesticHelpCosts")}
                    </Label>
                    <ProfileNumberInput
                        id={`domestic-help-${pid}`}
                        min={0}
                        step={10}
                        value={r.domesticHelpCosts}
                        onValueChange={(value) =>
                            setReductions({ domesticHelpCosts: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.domesticHelpCosts",
                        )}
                    />
                    <EligibilitySwitch
                        id={`domestic-help-eligible-${pid}`}
                        checked={!!r.domesticHelpEligible}
                        onCheckedChange={(v) =>
                            setReductions({ domesticHelpEligible: v })
                        }
                        label={t("tax.profile.flag.domesticHelpEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`service-vouchers-${pid}`}>
                        {t("tax.profile.field.serviceVoucherSpend")}
                    </Label>
                    <FieldHint>
                        {t("tax.profile.field.serviceVoucherSpend.desc")}
                    </FieldHint>
                    <ProfileNumberInput
                        id={`service-vouchers-${pid}`}
                        min={0}
                        step={10}
                        allowEmpty
                        value={r.serviceVoucherSpend}
                        onValueChange={(value) =>
                            updateHousehold((h) =>
                                updatePartner(h, pid, (p) => {
                                    const {
                                        serviceVoucherSpend: _old,
                                        ...reductions
                                    } = p.reductions;
                                    return {
                                        ...p,
                                        reductions:
                                            value === undefined
                                                ? reductions
                                                : {
                                                      ...reductions,
                                                      serviceVoucherSpend:
                                                          Math.max(value, 0),
                                                  },
                                    };
                                }),
                            )
                        }
                        placeholder={t(
                            "tax.profile.placeholder.serviceVoucherSpend",
                        )}
                    />
                    <EligibilitySwitch
                        id={`service-vouchers-eligible-${pid}`}
                        checked={!!r.serviceVoucherEligible}
                        onCheckedChange={(v) =>
                            setReductions({ serviceVoucherEligible: v })
                        }
                        label={t("tax.profile.flag.serviceVoucherEligible")}
                    />
                </div>

            </div>

            <Separator />

            <ToggleGroup>
                <ToggleRow
                    id={`isolated-parent-${pid}`}
                    label={t("tax.profile.field.isolatedParent.label")}
                    description={t("tax.profile.field.isolatedParent.desc")}
                    checked={partner.isIsolatedParent ?? false}
                    onCheckedChange={(v) =>
                        updateHousehold((h) =>
                            updatePartner(h, pid, (p) => ({
                                ...p,
                                isIsolatedParent: v,
                            })),
                        )
                    }
                />
            </ToggleGroup>
        </div>
    );
}
