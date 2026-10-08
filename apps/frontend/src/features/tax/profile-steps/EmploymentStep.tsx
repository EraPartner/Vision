import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { EmploymentType } from "@/lib/belgianTax";
import type { StepProps } from "./types";
import { ChoiceGroup, ChoiceRow, StepIntro } from "./ProfileRows";

const EMPLOYMENT_TYPES: EmploymentType[] = [
    "employee",
    "civil_servant",
    "self_employed",
    "director",
    "retired",
    "other",
];

export function EmploymentStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    return (
        <div className="space-y-4">
            <StepIntro
                title={t("tax.profile.section.employment.title")}
                description={t("tax.profile.section.employment.desc")}
            />
            <ChoiceGroup
                aria-label={t("tax.profile.section.employment.title")}
                value={profile.employmentType}
                onValueChange={(v) =>
                    updateProfile({ employmentType: v as EmploymentType })
                }
            >
                {EMPLOYMENT_TYPES.map((value) => (
                    <ChoiceRow
                        key={value}
                        id={`emp-${value}`}
                        value={value}
                        checked={profile.employmentType === value}
                        label={t(`tax.profile.employment.${value}.label`)}
                        description={t(`tax.profile.employment.${value}.desc`)}
                    />
                ))}
            </ChoiceGroup>
        </div>
    );
}
