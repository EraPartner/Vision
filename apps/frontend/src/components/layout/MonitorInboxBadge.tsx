import { Badge } from "@/components/ui/badge";
import { useMonitorNotifications } from "@/hooks/useMonitors";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

/** The persisted unread count is calculated server-side across all inbox pages. */
export function MonitorInboxBadge({
    collapsed = false,
}: {
    collapsed?: boolean;
}) {
    const { t } = useLanguage();
    const inbox = useMonitorNotifications(0);
    const unread = inbox.data?.unreadCount ?? 0;
    if (!unread) return null;
    return (
        <Badge
            variant="secondary"
            aria-label={t("monitors.unreadCount", { count: unread })}
            className={
                collapsed
                    ? "absolute -right-1 -top-1 min-w-4 px-1 py-0 text-2xs leading-4"
                    : "ml-auto shrink-0 px-1.5 py-0 text-2xs leading-4"
            }
        >
            {unread}
        </Badge>
    );
}
