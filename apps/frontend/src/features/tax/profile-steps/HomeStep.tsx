import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { HouseholdStepProps, StepProps } from "./types";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import { withoutMortgageRegion } from "./householdEditing";
import { ProfileNumberInput } from "./ProfileNumberInput";
import { ProfileNumberField } from "./ProfileNumberField";
import { BelgianRegionSelect } from "./ProfileSelectFields";
import {
    FieldHint,
    StepIntro,
    ToggleGroup,
    ToggleRow,
} from "./ProfileRows";

function OptionalBadge() {
    const { t } = useLanguage();
    return (
        <Badge variant="outline" size="sm" className="ml-1">
            {t("common.optional")}
        </Badge>
    );
}

/**
 * Home step: cadastral income, other residences and the regional own-home credit. The v1
 * fields go through `updateProfile`; the chèque habitat first qualifying year and the woonbonus
 * children at the loan start only exist on the household (ADR-200).
 */
export function HomeStep({
    profile,
    updateProfile,
    household,
    updateHousehold: updateHouseholdRaw,
}: StepProps & HouseholdStepProps) {
    const { t } = useLanguage();
    // The deprecated mortgage region (ADR-202) has no field here any more; any edit of a
    // household-only home field drops it, as v1 home edits do in the projection.
    const updateHousehold = (
        update: (h: BelgianTaxHouseholdV2) => BelgianTaxHouseholdV2,
    ) => updateHouseholdRaw((h) => withoutMortgageRegion(update(h)));
    const residenceUids = useRef<string[]>([]);
    const residences = profile.additionalResidences || [];
    while (residenceUids.current.length < residences.length) {
        residenceUids.current.push(crypto.randomUUID());
    }
    if (residenceUids.current.length > residences.length) {
        residenceUids.current.length = residences.length;
    }
    return (
        <div className="space-y-5">
            <StepIntro
                title={t("tax.profile.section.home.title")}
                description={t("tax.profile.section.home.desc")}
            />

            <ProfileNumberField
                id="cadastral"
                label={
                    <>
                        {t("tax.profile.field.cadastralIncome")}
                        <OptionalBadge />
                    </>
                }
                description={t("tax.profile.field.cadastralIncome.desc")}
                min={0}
                step={10}
                value={profile.cadastralIncome}
                onValueChange={(value) =>
                    updateProfile({ cadastralIncome: value ?? 0 })
                }
                placeholder={t("tax.profile.placeholder.cadastral")}
            />

            <div className="space-y-3">
                <StepIntro
                    title={t("tax.profile.section.residences.title")}
                    description={t("tax.profile.section.residences.desc")}
                />
                {residences.map((r, idx) => (
                    <div
                        key={residenceUids.current[idx]}
                        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3"
                    >
                        <div className="space-y-2">
                            <Label
                                htmlFor={`residence-label-${residenceUids.current[idx]}`}
                            >
                                {t("tax.profile.field.residenceLabel")}
                            </Label>
                            <Input
                                id={`residence-label-${residenceUids.current[idx]}`}
                                value={r.label || ""}
                                onChange={(e) => {
                                    const copy = [
                                        ...(profile.additionalResidences || []),
                                    ];
                                    copy[idx] = {
                                        ...r,
                                        label: e.target.value,
                                    };
                                    updateProfile({
                                        additionalResidences: copy,
                                    });
                                }}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor={`residence-cadastral-${residenceUids.current[idx]}`}
                            >
                                {t("tax.profile.field.cadastralIncome")}
                            </Label>
                            <ProfileNumberInput
                                id={`residence-cadastral-${residenceUids.current[idx]}`}
                                min={0}
                                step={10}
                                value={r.cadastralIncome}
                                onValueChange={(value) => {
                                    const copy = [
                                        ...(profile.additionalResidences || []),
                                    ];
                                    copy[idx] = {
                                        ...copy[idx],
                                        cadastralIncome: value ?? 0,
                                    };
                                    updateProfile({
                                        additionalResidences: copy,
                                    });
                                }}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor={`residence-region-${residenceUids.current[idx]}`}
                            >
                                {t("tax.profile.field.regionLabel")}
                            </Label>
                            <BelgianRegionSelect
                                id={`residence-region-${residenceUids.current[idx]}`}
                                value={r.region || profile.region}
                                onValueChange={(v) => {
                                    const copy = [
                                        ...(profile.additionalResidences || []),
                                    ];
                                    copy[idx] = {
                                        ...r,
                                        region: v,
                                    };
                                    updateProfile({
                                        additionalResidences: copy,
                                    });
                                }}
                                className="w-full"
                            />
                        </div>
                    </div>
                ))}
                <div className="flex gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            const copy = [
                                ...(profile.additionalResidences || []),
                            ];
                            copy.push({
                                label: "",
                                cadastralIncome: 0,
                                region: profile.region,
                            });
                            updateProfile({ additionalResidences: copy });
                        }}
                    >
                        {t("tax.profile.addResidence")}
                    </Button>
                    {residences.length > 0 && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                updateProfile({ additionalResidences: [] })
                            }
                        >
                            {t("common.reset")}
                        </Button>
                    )}
                </div>
            </div>

            <Separator />

            <div className="space-y-3">
                <StepIntro
                    title={t("tax.profile.section.ownHome.title")}
                    description={t("tax.profile.section.ownHome.desc")}
                />

                <ToggleGroup>
                    <ToggleRow
                        id="own-home-primary"
                        label={t("tax.profile.field.mortgageIsPrimaryResidence")}
                        description={t(
                            "tax.profile.field.mortgageIsPrimaryResidence.desc",
                        )}
                        checked={!!profile.mortgageIsPrimaryResidence}
                        onCheckedChange={(v) =>
                            updateProfile({ mortgageIsPrimaryResidence: v })
                        }
                    />
                </ToggleGroup>

                {profile.mortgageIsPrimaryResidence && (
                    <div className="space-y-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="mortgage-year">
                                    {t("tax.profile.field.mortgageStartYear")}
                                </Label>
                                <ProfileNumberInput
                                    id="mortgage-year"
                                    min={1990}
                                    max={new Date().getFullYear()}
                                    step={1}
                                    value={profile.mortgageStartYear}
                                    integer
                                    allowEmpty
                                    onValueChange={(value) =>
                                        updateProfile({
                                            mortgageStartYear: value,
                                        })
                                    }
                                    placeholder={t(
                                        "tax.profile.placeholder.mortgageStartYear",
                                    )}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <ProfileNumberField
                                id="mortgage-interest"
                                label={t(
                                    "tax.profile.field.mortgageInterestPaid",
                                )}
                                min={0}
                                step={10}
                                value={profile.mortgageInterestPaid}
                                onValueChange={(value) =>
                                    updateProfile({
                                        mortgageInterestPaid: value ?? 0,
                                    })
                                }
                                placeholder={t(
                                    "tax.profile.placeholder.mortgageInterestPaid",
                                )}
                            />
                            <ProfileNumberField
                                id="mortgage-capital"
                                label={t(
                                    "tax.profile.field.mortgageCapitalRepaid",
                                )}
                                min={0}
                                step={10}
                                value={profile.mortgageCapitalRepaid}
                                onValueChange={(value) =>
                                    updateProfile({
                                        mortgageCapitalRepaid: value ?? 0,
                                    })
                                }
                                placeholder={t(
                                    "tax.profile.placeholder.mortgageCapitalRepaid",
                                )}
                            />
                        </div>

                        {profile.region ===
                            "wallonia" && (
                            <ProfileNumberField
                                id="cheque-habitat-first-year"
                                label={
                                    <>
                                        {t(
                                            "tax.profile.field.chequeHabitatFirstYear",
                                        )}
                                        <OptionalBadge />
                                    </>
                                }
                                description={t(
                                    "tax.profile.field.chequeHabitatFirstYear.desc",
                                )}
                                min={2016}
                                max={household.taxYear}
                                step={1}
                                integer
                                allowEmpty
                                value={household.home.firstQualifyingYear}
                                onValueChange={(value) =>
                                    updateHousehold((h) => {
                                        const {
                                            firstQualifyingYear: _old,
                                            ...home
                                        } = h.home;
                                        return {
                                            ...h,
                                            home:
                                                value !== undefined &&
                                                value >= 1900 &&
                                                value <= 2200
                                                    ? {
                                                          ...home,
                                                          firstQualifyingYear:
                                                              value,
                                                      }
                                                    : home,
                                        };
                                    })
                                }
                                placeholder={t(
                                    "tax.profile.placeholder.chequeHabitatFirstYear",
                                )}
                                className="w-32"
                            />
                        )}

                        {profile.region ===
                            "flanders" &&
                            profile.mortgageStartYear !== undefined &&
                            profile.mortgageStartYear < 2020 && (
                                <ProfileNumberField
                                    id="woonbonus-children-at-loan-start"
                                    label={
                                        <>
                                            {t(
                                                "tax.profile.field.woonbonusChildrenAtLoanStart",
                                            )}
                                            <OptionalBadge />
                                        </>
                                    }
                                    description={t(
                                        "tax.profile.field.woonbonusChildrenAtLoanStart.desc",
                                    )}
                                    min={0}
                                    max={1000}
                                    step={1}
                                    integer
                                    allowEmpty
                                    value={
                                        household.home
                                            .woonbonusChildrenAtLoanStart
                                    }
                                    onValueChange={(value) =>
                                        updateHousehold((h) => {
                                            const {
                                                woonbonusChildrenAtLoanStart:
                                                    _old,
                                                ...home
                                            } = h.home;
                                            return {
                                                ...h,
                                                home:
                                                    value !== undefined &&
                                                    Number.isInteger(value) &&
                                                    value >= 0 &&
                                                    value <= 1000
                                                        ? {
                                                              ...home,
                                                              woonbonusChildrenAtLoanStart:
                                                                  value,
                                                          }
                                                        : home,
                                            };
                                        })
                                    }
                                    placeholder={t(
                                        "tax.profile.placeholder.woonbonusChildrenAtLoanStart",
                                    )}
                                    className="w-32"
                                />
                            )}

                        <FieldHint>
                            {t("tax.profile.section.ownHome.note")}
                        </FieldHint>
                    </div>
                )}
            </div>
        </div>
    );
}
