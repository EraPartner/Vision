import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import type { ProfessionalExpenseMethod } from "@/lib/belgianTax";
import type { StepProps } from "./types";
import { ProfileNumberInput } from "./ProfileNumberInput";
import { ProfileNumberField } from "./ProfileNumberField";
import { BelgianRegionSelect } from "./ProfileSelectFields";

export function IncomeStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
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
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">
                    {t("tax.profile.section.income.title")}
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                    {t("tax.profile.section.income.desc")}
                </p>
            </div>

            <ProfileNumberField
                id="gross-income"
                label={t("tax.profile.field.grossAnnualIncome")}
                description={t("tax.profile.field.grossAnnualIncome.desc")}
                min={0}
                step={100}
                value={profile.grossAnnualIncome}
                onValueChange={(value) =>
                    updateProfile({ grossAnnualIncome: value ?? 0 })
                }
                placeholder={t("tax.profile.placeholder.grossIncome")}
            />

            <ProfileNumberField
                id="other-income"
                label={
                    <>
                        {t("tax.profile.field.otherTaxableIncome")}{" "}
                        <Badge variant="outline" className="text-2xs ml-1">
                            {t("common.optional")}
                        </Badge>
                    </>
                }
                description={t("tax.profile.field.otherTaxableIncome.desc")}
                min={0}
                step={100}
                value={profile.otherTaxableIncome}
                onValueChange={(value) =>
                    updateProfile({ otherTaxableIncome: value ?? 0 })
                }
                placeholder={t("tax.profile.placeholder.otherIncome")}
            />

            <Separator />

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-semibold text-foreground mb-1">
                        {t("tax.profile.section.professionalExpenses.title")}
                    </p>
                    <p className="text-xs text-muted-foreground mb-3">
                        {t("tax.profile.section.professionalExpenses.desc")}
                    </p>
                </div>
                <RadioGroup
                    value={profile.professionalExpenseMethod}
                    onValueChange={(v) =>
                        updateProfile({
                            professionalExpenseMethod:
                                v as ProfessionalExpenseMethod,
                        })
                    }
                    className="space-y-2"
                >
                    <div
                        className={cn(
                            "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                            profile.professionalExpenseMethod === "lump_sum"
                                ? "border-primary bg-primary/5"
                                : "border-border hover:bg-muted/40",
                        )}
                    >
                        <RadioGroupItem
                            value="lump_sum"
                            id="exp-lump"
                            className="mt-0.5"
                        />
                        <Label
                            htmlFor="exp-lump"
                            className="cursor-pointer flex-1"
                        >
                            <span className="font-medium text-sm block">
                                {t("tax.profile.profExp.lump.label")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("tax.profile.profExp.lump.desc")}
                            </span>
                        </Label>
                    </div>
                    <div
                        className={cn(
                            "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                            profile.professionalExpenseMethod === "actual"
                                ? "border-primary bg-primary/5"
                                : "border-border hover:bg-muted/40",
                        )}
                    >
                        <RadioGroupItem
                            value="actual"
                            id="exp-actual"
                            className="mt-0.5"
                        />
                        <Label
                            htmlFor="exp-actual"
                            className="cursor-pointer flex-1"
                        >
                            <span className="font-medium text-sm block">
                                {t("tax.profile.profExp.actual.label")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("tax.profile.profExp.actual.desc")}
                            </span>
                        </Label>
                    </div>
                </RadioGroup>

                {profile.professionalExpenseMethod === "actual" && (
                    <ProfileNumberField
                        id="actual-expenses"
                        containerClassName="space-y-2 pt-1"
                        label={t(
                            "tax.profile.field.actualProfessionalExpenses",
                        )}
                        min={0}
                        step={100}
                        value={profile.actualProfessionalExpenses}
                        onValueChange={(value) =>
                            updateProfile({
                                actualProfessionalExpenses: value ?? 0,
                            })
                        }
                        placeholder={t(
                            "tax.profile.placeholder.actualExpenses",
                        )}
                    />
                )}
            </div>

            <ProfileNumberField
                id="cadastral"
                label={
                    <>
                        {t("tax.profile.field.cadastralIncome")}{" "}
                        <Badge variant="outline" className="text-2xs ml-1">
                            {t("common.optional")}
                        </Badge>
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

            <div>
                <p className="text-sm font-semibold text-foreground mb-2">
                    {t("tax.profile.section.residences.title")}
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                    {t("tax.profile.section.residences.desc")}
                </p>
                {residences.map((r, idx) => (
                    <div
                        key={residenceUids.current[idx]}
                        className="grid grid-cols-1 gap-2 items-end mb-2 sm:grid-cols-3"
                    >
                        <div className="col-span-1">
                            <Label
                                htmlFor={`residence-label-${residenceUids.current[idx]}`}
                                className="text-xs"
                            >
                                {t("tax.profile.field.residenceLabel") ||
                                    "Label"}
                            </Label>
                            <Input
                                id={`residence-label-${residenceUids.current[idx]}`}
                                value={r.label || ""}
                                onChange={(e) => {
                                    const copy = [
                                        ...(profile.additionalResidences || []),
                                    ];
                                    copy[idx] = {
                                        ...copy[idx],
                                        label: e.target.value,
                                    };
                                    updateProfile({
                                        additionalResidences: copy,
                                    });
                                }}
                            />
                        </div>
                        <div>
                            <Label
                                htmlFor={`residence-cadastral-${residenceUids.current[idx]}`}
                                className="text-xs"
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
                        <div>
                            <Label
                                htmlFor={`residence-region-${residenceUids.current[idx]}`}
                                className="text-xs"
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
                                        ...copy[idx],
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
                        {t("tax.profile.addResidence") || "Add residence"}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                            updateProfile({ additionalResidences: [] })
                        }
                    >
                        {t("common.reset")}
                    </Button>
                </div>
            </div>

            <Separator />

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-semibold text-foreground mb-1">
                        {t("tax.profile.section.ownHome.title")}
                    </p>
                    <p className="text-xs text-muted-foreground mb-3">
                        {t("tax.profile.section.ownHome.desc")}
                    </p>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex-1">
                        <Label
                            htmlFor="own-home-primary"
                            className="text-sm font-medium cursor-pointer"
                        >
                            {t("tax.profile.field.mortgageIsPrimaryResidence")}
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {t(
                                "tax.profile.field.mortgageIsPrimaryResidence.desc",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="own-home-primary"
                        checked={!!profile.mortgageIsPrimaryResidence}
                        onCheckedChange={(v) =>
                            updateProfile({ mortgageIsPrimaryResidence: v })
                        }
                    />
                </div>

                {profile.mortgageIsPrimaryResidence && (
                    <div className="space-y-3 pl-1">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                                <Label
                                    htmlFor="mortgage-year"
                                    className="text-xs"
                                >
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
                            <div>
                                <Label
                                    htmlFor="mortgage-region"
                                    className="text-xs"
                                >
                                    {t("tax.profile.field.mortgageRegion")}
                                </Label>
                                <BelgianRegionSelect
                                    id="mortgage-region"
                                    value={
                                        profile.mortgageRegion ?? profile.region
                                    }
                                    onValueChange={(v) =>
                                        updateProfile({
                                            mortgageRegion: v,
                                        })
                                    }
                                    className="w-full"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <ProfileNumberField
                                id="mortgage-interest"
                                containerClassName=""
                                labelClassName="text-xs"
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
                                containerClassName=""
                                labelClassName="text-xs"
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

                        <p className="text-2xs text-muted-foreground">
                            {t("tax.profile.section.ownHome.note")}
                        </p>
                    </div>
                )}
            </div>

            <Separator />
        </div>
    );
}
