import { Plus, Trash2, Users } from "lucide-react";
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
// By path: the barrel re-exports the household engine (see belgianTaxStore.ts).
import { useHouseholdComputation } from "@/hooks/useBelgianTaxComputation";
import {
    RELATIONSHIP_EVENT_KINDS,
    type PartnerId,
    type RelationshipEvent,
    type RelationshipEventKind,
} from "@/lib/belgianTax/householdTypes";
import type { HouseholdStepProps } from "./types";
import { ProfileNumberInput } from "./ProfileNumberInput";
import {
    addPartnerB,
    addRelationshipEvent,
    partnerLabel,
    removePartnerB,
    removeRelationshipEvent,
    updateRelationshipEvent,
} from "./householdEditing";
import { FieldHint, StepIntro, ToggleGroup, ToggleRow } from "./ProfileRows";

const surfaceClass =
    "rounded-card corner-continuous border border-border/60 bg-card/70";

function dateValue(iso: string): Date | undefined {
    const date = parseLocalDateFromYmd(iso);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

interface PartnerSelectProps {
    id: string;
    value: PartnerId;
    partners: PartnerId[];
    onValueChange: (value: PartnerId) => void;
    disabled?: boolean;
    describedBy?: string;
}

function PartnerSelect({
    id,
    value,
    partners,
    onValueChange,
    disabled,
    describedBy,
}: PartnerSelectProps) {
    const { t } = useLanguage();
    return (
        <Select
            value={value}
            onValueChange={(next) => onValueChange(next as PartnerId)}
            {...(disabled ? { disabled: true } : {})}
        >
            <SelectTrigger
                id={id}
                className="w-full"
                {...(describedBy ? { "aria-describedby": describedBy } : {})}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {partners.map((partnerId) => (
                    <SelectItem key={partnerId} value={partnerId}>
                        {partnerLabel(t, partnerId)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

interface EventRowProps {
    event: RelationshipEvent;
    partners: PartnerId[];
    onChange: (patch: {
        kind?: RelationshipEventKind;
        date?: string;
        partnerId?: PartnerId;
    }) => void;
    onRemove: () => void;
    portalContainer?: HTMLElement | null | undefined;
}

function EventRow({
    event,
    partners,
    onChange,
    onRemove,
    portalContainer,
}: EventRowProps) {
    const { t } = useLanguage();
    const kindLabel = t(`tax.household.event.kind.${event.kind}`);
    return (
        <div className={`${surfaceClass} space-y-3 p-4`}>
            <div className="flex items-end gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor={`${event.id}-kind`}>
                            {t("tax.household.event.kindLabel")}
                        </Label>
                        <Select
                            value={event.kind}
                            onValueChange={(kind) =>
                                onChange({ kind: kind as RelationshipEventKind })
                            }
                        >
                            <SelectTrigger id={`${event.id}-kind`} className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {RELATIONSHIP_EVENT_KINDS.map((kind) => (
                                    <SelectItem key={kind} value={kind}>
                                        {t(`tax.household.event.kind.${kind}`)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={`${event.id}-date`}>
                            {t("tax.household.event.date")}
                        </Label>
                        <DatePicker
                            id={`${event.id}-date`}
                            value={dateValue(event.date)}
                            onChange={(date) => {
                                if (date) onChange({ date: toYmd(date) });
                            }}
                            portalContainer={portalContainer}
                            buttonClassName="w-full"
                        />
                    </div>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onRemove}
                    aria-label={t("tax.household.event.remove", {
                        event: kindLabel,
                    })}
                >
                    <Trash2 aria-hidden="true" />
                </Button>
            </div>
            {event.kind === "death" && (
                <div className="space-y-2">
                    <Label htmlFor={`${event.id}-partner`}>
                        {t("tax.household.event.deceased")}
                    </Label>
                    <PartnerSelect
                        id={`${event.id}-partner`}
                        value={event.partnerId ?? "B"}
                        partners={partners}
                        onValueChange={(partnerId) => onChange({ partnerId })}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * Household step (ADR-200): the assessment the server derives for the income year (shown once
 * computed, following edits after a short pause), the partner toggle,
 * the dated relationship events the assessment rests on, and which partner claims the
 * dependants and the own-home credit.
 */
export function HouseholdStep({
    household,
    updateHousehold,
    portalContainer,
}: HouseholdStepProps) {
    const { t } = useLanguage();
    const year = household.taxYear;
    const decision = useHouseholdComputation(household).data?.result.assessment;
    const hasPartner = household.partners.some((p) => p.id === "B");
    const partnerIds = household.partners.map((p) => p.id);
    // With partner B's share entered, the share decides who claims the own-home credit (0 → A,
    // 100 → B, 1-99 → both), so the single-claimant picker no longer applies.
    const shareB = household.home.mortgageSharePartnerB;
    const shareSet = shareB !== undefined && partnerIds.includes("B");
    const events = household.relationship.events;

    return (
        <div className="space-y-5">
            <StepIntro
                title={t("tax.household.section.title")}
                description={t("tax.household.section.desc")}
            />

            <section
                aria-labelledby="household-assessment-title"
                className={`${surfaceClass} flex items-start gap-3 px-4 py-3`}
            >
                <Users
                    className="mt-0.5 h-4 w-4 shrink-0 text-label-secondary"
                    aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4
                            id="household-assessment-title"
                            className="type-body font-medium text-foreground"
                        >
                            {t("tax.household.assessment.title", {
                                year: String(year),
                            })}
                        </h4>
                        {decision && (
                            <Badge variant="outline" size="sm">
                                {t(
                                    `tax.household.assessment.mode.${decision.mode}`,
                                )}
                            </Badge>
                        )}
                    </div>
                    {decision && (
                        <>
                            <FieldHint>
                                {t(
                                    `tax.household.assessment.reason.${decision.reason}`,
                                )}
                            </FieldHint>
                            <p className="type-caption text-label-tertiary">
                                {decision.legalBasis}
                            </p>
                        </>
                    )}
                </div>
            </section>

            <ToggleGroup>
                <ToggleRow
                    id="household-has-partner"
                    label={t("tax.household.field.hasPartner")}
                    description={t("tax.household.field.hasPartner.desc")}
                    checked={hasPartner}
                    onCheckedChange={(v) =>
                        updateHousehold((h) =>
                            v ? addPartnerB(h) : removePartnerB(h),
                        )
                    }
                />
                {decision?.electable && (
                    <ToggleRow
                        id="household-death-year-joint"
                        label={t("tax.household.field.deathYearJoint")}
                        description={t("tax.household.field.deathYearJoint.desc")}
                        checked={
                            household.relationship.deathYearElection === "joint"
                        }
                        onCheckedChange={(v) =>
                            updateHousehold((h) => ({
                                ...h,
                                relationship: {
                                    ...h.relationship,
                                    deathYearElection: v ? "joint" : "separate",
                                },
                            }))
                        }
                    />
                )}
            </ToggleGroup>

            {hasPartner && (
                <>
                    <Separator />
                    <div className="space-y-3">
                        <StepIntro
                            title={t("tax.household.events.title")}
                            description={t("tax.household.events.desc")}
                        />
                        {events.map((event) => (
                            <EventRow
                                key={event.id}
                                event={event}
                                partners={partnerIds}
                                onChange={(patch) =>
                                    updateHousehold((h) =>
                                        updateRelationshipEvent(h, event.id, patch),
                                    )
                                }
                                onRemove={() =>
                                    updateHousehold((h) =>
                                        removeRelationshipEvent(h, event.id),
                                    )
                                }
                                portalContainer={portalContainer}
                            />
                        ))}
                        {events.length === 0 && (
                            <FieldHint>{t("tax.household.events.empty")}</FieldHint>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                // Default to a marriage before the income year: a marriage in
                                // the year itself is assessed separately (art. 126 §2 1°), which
                                // would flip a migrated joint household until the date is edited.
                                updateHousehold((h) =>
                                    addRelationshipEvent(h, "marriage", `${year - 1}-01-01`),
                                )
                            }
                        >
                            <Plus aria-hidden="true" />
                            {t("tax.household.event.add")}
                        </Button>
                    </div>

                    <Separator />
                    <div className="space-y-3">
                        <StepIntro
                            title={t("tax.household.claims.title")}
                            description={t("tax.household.claims.desc")}
                        />
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="household-dependants-claimant">
                                    {t("tax.household.field.dependantsClaimant")}
                                </Label>
                                <PartnerSelect
                                    id="household-dependants-claimant"
                                    value={
                                        household.dependents.claimantPartnerId ??
                                        "A"
                                    }
                                    partners={partnerIds}
                                    onValueChange={(claimantPartnerId) =>
                                        updateHousehold((h) => ({
                                            ...h,
                                            dependents: {
                                                ...h.dependents,
                                                claimantPartnerId,
                                            },
                                        }))
                                    }
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="household-home-claimant">
                                    {t("tax.household.field.ownHomeClaimant")}
                                </Label>
                                <PartnerSelect
                                    id="household-home-claimant"
                                    value={
                                        shareSet && shareB === 100
                                            ? "B"
                                            : shareSet && shareB === 0
                                              ? "A"
                                              : (household.home.mortgageCreditPartnerId ??
                                                "A")
                                    }
                                    partners={partnerIds}
                                    disabled={shareSet}
                                    {...(shareSet
                                        ? { describedBy: "household-home-claimant-hint" }
                                        : {})}
                                    onValueChange={(mortgageCreditPartnerId) =>
                                        updateHousehold((h) => ({
                                            ...h,
                                            home: {
                                                ...h.home,
                                                mortgageCreditPartnerId,
                                            },
                                        }))
                                    }
                                />
                                {shareSet && (
                                    <FieldHint id="household-home-claimant-hint">
                                        {t("tax.household.field.ownHomeClaimant.shareSet")}
                                    </FieldHint>
                                )}
                            </div>
                            {partnerIds.includes("B") && (
                                <div className="space-y-2">
                                    <Label htmlFor="household-home-share-b">
                                        {t("tax.household.field.mortgageSharePartnerB")}
                                    </Label>
                                    <ProfileNumberInput
                                        id="household-home-share-b"
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={household.home.mortgageSharePartnerB}
                                        allowEmpty
                                        onValueChange={(mortgageSharePartnerB) =>
                                            updateHousehold((h) => {
                                                const { mortgageSharePartnerB: _old, ...home } =
                                                    h.home;
                                                return {
                                                    ...h,
                                                    home:
                                                        mortgageSharePartnerB === undefined
                                                            ? home
                                                            : { ...home, mortgageSharePartnerB },
                                                };
                                            })
                                        }
                                        placeholder={t(
                                            "tax.household.placeholder.mortgageSharePartnerB",
                                        )}
                                    />
                                    <FieldHint>
                                        {t("tax.household.field.mortgageSharePartnerB.desc")}
                                    </FieldHint>
                                </div>
                            )}
                        </div>
                        <FieldHint>{t("tax.household.claims.note")}</FieldHint>
                    </div>
                </>
            )}
        </div>
    );
}
