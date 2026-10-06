import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useNeedsCategoryCount } from "@/hooks/useNeedsCategoryCount";
import { useUpcomingPlannedPayments } from "@/hooks/useUpcomingPlannedPayments";
import { useInsightsCount } from "@/hooks/useInsightsDigest";
import { useMonitorNotifications } from "@/hooks/useMonitors";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/navigation";

type BadgeKind = NonNullable<NavItem["badge"]>;

interface NavItemBadgeProps {
    kind: BadgeKind;
    /** Icon rail: the count becomes a small pill on the icon's corner. */
    collapsed?: boolean;
}

/**
 * The live count beside a sidebar item (ADR-180). `hot` counts are things
 * that need the user now (uncategorized transactions, payments due) and
 * render filled; `quiet` counts are things waiting to be read.
 */
export function SidebarCount({
    count,
    label,
    tone = "quiet",
    collapsed = false,
}: {
    count: number;
    /** Screen-reader text for the count, e.g. "3 need a category". */
    label: string;
    tone?: "hot" | "quiet";
    collapsed?: boolean;
}) {
    if (!count) return null;
    return (
        <span
            data-sidebar="count"
            data-tone={tone}
            className={cn(
                "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 type-caption tabular-nums",
                tone === "hot"
                    ? "bg-primary font-semibold text-primary-foreground"
                    : "text-label-tertiary",
                collapsed &&
                    "absolute -right-1 -top-1 h-4 min-w-4 px-1 bg-primary font-semibold text-primary-foreground",
            )}
        >
            <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
            <span className="sr-only">{label}</span>
        </span>
    );
}

function NeedsCategoryCount({ collapsed }: { collapsed: boolean }) {
    const { t } = useLanguage();
    const { data: count } = useNeedsCategoryCount();
    if (!count) return null;
    return (
        <SidebarCount
            count={count}
            tone="hot"
            collapsed={collapsed}
            label={t("nav.needsCategoryCount", { count })}
        />
    );
}

function PlannedDueCount({ collapsed }: { collapsed: boolean }) {
    const { t } = useLanguage();
    const { visibleUpcoming } = useUpcomingPlannedPayments();
    const count = visibleUpcoming.length;
    if (!count) return null;
    return (
        <SidebarCount
            count={count}
            tone="hot"
            collapsed={collapsed}
            label={t("nav.plannedDueCount", { count })}
        />
    );
}

/** Undismissed-insights count: reads only the persisted count projection. */
function InsightsCount({ collapsed }: { collapsed: boolean }) {
    const { t } = useLanguage();
    const { data } = useInsightsCount();
    if (data?.status !== "ready" || !data.count) return null;
    return (
        <SidebarCount
            count={data.count}
            collapsed={collapsed}
            label={t("nav.insightsCount", { count: data.count })}
        />
    );
}

/** The persisted unread count is calculated server-side across all inbox pages. */
function MonitorInboxCount({ collapsed }: { collapsed: boolean }) {
    const { t } = useLanguage();
    const inbox = useMonitorNotifications(0);
    const unread = inbox.data?.unreadCount ?? 0;
    if (!unread) return null;
    return (
        <SidebarCount
            count={unread}
            collapsed={collapsed}
            label={t("monitors.unreadCount", { count: unread })}
        />
    );
}

export function NavItemBadge({ kind, collapsed = false }: NavItemBadgeProps) {
    switch (kind) {
        case "needs-category":
            return <NeedsCategoryCount collapsed={collapsed} />;
        case "planned-due":
            return <PlannedDueCount collapsed={collapsed} />;
        case "insights":
            return <InsightsCount collapsed={collapsed} />;
        case "monitors":
            return <MonitorInboxCount collapsed={collapsed} />;
    }
}
