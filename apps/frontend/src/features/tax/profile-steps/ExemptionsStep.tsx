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
import type { StepProps } from "./types";
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

export function ExemptionsStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
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

            <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                    <Label htmlFor="alimony">
                        {t("tax.profile.field.alimonyPaid")}
                    </Label>
                    <ProfileNumberInput
                        id="alimony"
                        min={0}
                        step={10}
                        value={profile.alimonyPaid}
                        onValueChange={(value) =>
                            updateProfile({ alimonyPaid: value ?? 0 })
                        }
                        placeholder={t("tax.profile.placeholder.alimonyPaid")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="pension">
                        {t("tax.profile.field.personalPensionContributions")}
                    </Label>
                    <ProfileNumberInput
                        id="pension"
                        min={0}
                        step={10}
                        value={profile.personalPensionContributions}
                        onValueChange={(value) =>
                            updateProfile({
                                personalPensionContributions: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.personalPensionContributions",
                        )}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <Select
                            value={profile.pensionScheme}
                            onValueChange={(v) =>
                                updateProfile({
                                    pensionScheme: v as "1050" | "1350",
                                })
                            }
                        >
                            <SelectTrigger id="pension-scheme" className="w-56">
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
                            id="pension-eligible"
                            checked={!!profile.pensionEligible}
                            onCheckedChange={(v) =>
                                updateProfile({ pensionEligible: v })
                            }
                            label={t("tax.profile.flag.pensionEligible")}
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="group-insurance">
                        {t(
                            "tax.profile.field.employeeGroupInsuranceContributions",
                        )}
                    </Label>
                    <ProfileNumberInput
                        id="group-insurance"
                        min={0}
                        step={10}
                        value={profile.employeeGroupInsuranceContributions}
                        onValueChange={(value) =>
                            updateProfile({
                                employeeGroupInsuranceContributions: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.employeeGroupInsuranceContributions",
                        )}
                    />
                    <EligibilitySwitch
                        id="group-insurance-eligible"
                        checked={!!profile.employeeGroupInsuranceEligible}
                        onCheckedChange={(v) =>
                            updateProfile({
                                employeeGroupInsuranceEligible: v,
                            })
                        }
                        label={t(
                            "tax.profile.flag.employeeGroupInsuranceEligible",
                        )}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="life">
                        {t("tax.profile.field.lifeInsurancePremiums")}
                    </Label>
                    <ProfileNumberInput
                        id="life"
                        min={0}
                        step={10}
                        value={profile.lifeInsurancePremiums}
                        onValueChange={(value) =>
                            updateProfile({ lifeInsurancePremiums: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.lifeInsurancePremiums",
                        )}
                    />
                    <EligibilitySwitch
                        id="life-eligible"
                        checked={!!profile.lifeInsuranceEligible}
                        onCheckedChange={(v) =>
                            updateProfile({ lifeInsuranceEligible: v })
                        }
                        label={t("tax.profile.flag.lifeInsuranceEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="donations">
                        {t("tax.profile.field.charitableDonations")}
                    </Label>
                    <ProfileNumberInput
                        id="donations"
                        min={0}
                        step={10}
                        value={profile.charitableDonations}
                        onValueChange={(value) =>
                            updateProfile({ charitableDonations: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.charitableDonations",
                        )}
                    />
                    <EligibilitySwitch
                        id="donations-eligible"
                        checked={!!profile.charitableDonationsEligible}
                        onCheckedChange={(v) =>
                            updateProfile({
                                charitableDonationsEligible: v,
                            })
                        }
                        label={t(
                            "tax.profile.flag.charitableDonationsEligible",
                        )}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="childcare">
                        {t("tax.profile.field.childcareCosts")}
                    </Label>
                    <ProfileNumberInput
                        id="childcare"
                        min={0}
                        step={10}
                        value={profile.childcareCosts}
                        onValueChange={(value) =>
                            updateProfile({ childcareCosts: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.childcareCosts",
                        )}
                    />
                    <Label htmlFor="childcare-days">
                        {t("tax.profile.field.childcareEligibleDays")}
                    </Label>
                    <ProfileNumberInput
                        id="childcare-days"
                        min={0}
                        step={1}
                        integer
                        value={profile.childcareEligibleDays}
                        onValueChange={(value) =>
                            updateProfile({
                                childcareEligibleDays: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.childcareEligibleDays",
                        )}
                    />
                    <EligibilitySwitch
                        id="childcare-eligible"
                        checked={!!profile.childcareEligible}
                        onCheckedChange={(v) =>
                            updateProfile({ childcareEligible: v })
                        }
                        label={t("tax.profile.flag.childcareEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="domestic-help">
                        {t("tax.profile.field.domesticHelpCosts")}
                    </Label>
                    <ProfileNumberInput
                        id="domestic-help"
                        min={0}
                        step={10}
                        value={profile.domesticHelpCosts}
                        onValueChange={(value) =>
                            updateProfile({ domesticHelpCosts: value ?? 0 })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.domesticHelpCosts",
                        )}
                    />
                    <EligibilitySwitch
                        id="domestic-help-eligible"
                        checked={!!profile.domesticHelpEligible}
                        onCheckedChange={(v) =>
                            updateProfile({ domesticHelpEligible: v })
                        }
                        label={t("tax.profile.flag.domesticHelpEligible")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="union">
                        {t("tax.profile.field.unionDues")}
                    </Label>
                    <ProfileNumberInput
                        id="union"
                        min={0}
                        step={10}
                        value={profile.unionDues}
                        onValueChange={(value) =>
                            updateProfile({ unionDues: value ?? 0 })
                        }
                        placeholder={t("tax.profile.placeholder.unionDues")}
                    />
                    <FieldHint>{t("tax.profile.field.unionDues.desc")}</FieldHint>
                </div>
            </div>

            <Separator />

            <ToggleGroup>
                <ToggleRow
                    id="disabled"
                    label={t("tax.profile.field.disabilityExemption.self")}
                    description={t(
                        "tax.profile.field.disabilityExemption.desc",
                    )}
                    checked={profile.isDisabled}
                    onCheckedChange={(v) => updateProfile({ isDisabled: v })}
                />
                <ToggleRow
                    id="spouse-disabled"
                    label={t("tax.profile.field.disabilityExemption.spouse")}
                    description={t(
                        "tax.profile.field.disabilityExemption.desc",
                    )}
                    checked={profile.isSpouseDisabled}
                    onCheckedChange={(v) =>
                        updateProfile({ isSpouseDisabled: v })
                    }
                />
                <ToggleRow
                    id="isolated-parent"
                    label={t("tax.profile.field.isolatedParent.label")}
                    description={t("tax.profile.field.isolatedParent.desc")}
                    checked={profile.isIsolatedParent ?? false}
                    onCheckedChange={(v) =>
                        updateProfile({ isIsolatedParent: v })
                    }
                />
            </ToggleGroup>
        </div>
    );
}
