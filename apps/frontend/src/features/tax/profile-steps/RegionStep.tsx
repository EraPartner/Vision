import { Label } from "@/components/ui/label";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    DEFAULT_COMMUNAL_SURCHARGE,
    type BelgianRegion,
} from "@/lib/belgianTax";
import type { StepProps } from "./types";
import { ProfileNumberInput } from "./ProfileNumberInput";
import { ChoiceGroup, ChoiceRow, FieldHint, StepIntro } from "./ProfileRows";

const REGIONS: BelgianRegion[] = ["flanders", "wallonia", "brussels"];

export function RegionStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    return (
        <div className="space-y-5">
            <StepIntro
                title={t("tax.profile.section.region.title")}
                description={t("tax.profile.section.region.desc")}
            />

            <div className="space-y-2">
                <p
                    id="tax-region-label"
                    className="type-body font-medium text-label-primary"
                >
                    {t("tax.profile.field.regionLabel")}
                </p>
                <ChoiceGroup
                    aria-labelledby="tax-region-label"
                    value={profile.region}
                    onValueChange={(v) => {
                        const r = v as BelgianRegion;
                        updateProfile({
                            region: r,
                            communalSurchargePercent:
                                DEFAULT_COMMUNAL_SURCHARGE[r],
                        });
                    }}
                >
                    {REGIONS.map((value) => (
                        <ChoiceRow
                            key={value}
                            id={`region-${value}`}
                            value={value}
                            checked={profile.region === value}
                            label={t(`tax.profile.region.${value}.label`)}
                            description={
                                <>
                                    {t(`tax.profile.region.${value}.desc`)}{" "}
                                    {t("tax.profile.region.defaultSurcharge", {
                                        pct: DEFAULT_COMMUNAL_SURCHARGE[value],
                                    })}
                                </>
                            }
                        />
                    ))}
                </ChoiceGroup>
            </div>

            <div className="space-y-2">
                <Label htmlFor="communal-surcharge">
                    {t("tax.profile.field.communalSurcharge")}
                </Label>
                <FieldHint>
                    {t("tax.profile.field.communalSurcharge.desc")}
                </FieldHint>
                <div className="flex items-center gap-3">
                    <ProfileNumberInput
                        id="communal-surcharge"
                        min={0}
                        max={9}
                        step={0.1}
                        value={profile.communalSurchargePercent}
                        onValueChange={(value) =>
                            updateProfile({
                                communalSurchargePercent: value ?? 0,
                            })
                        }
                        className="w-24"
                    />
                    <span className="type-body text-label-secondary">
                        {t("tax.profile.communalSurchargePct")}
                    </span>
                </div>
            </div>
        </div>
    );
}
