import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { matchNavTitleKey } from "@/lib/navigation";

// Shown for routes with no nav entry (e.g. deep detail pages) and mirrors the
// static <title> in index.html so unmatched routes read consistently.
const DEFAULT_TITLE = "Vision - Financial Management";

/**
 * Keeps `document.title` in sync with the current route, so history entries and
 * bookmarks are distinguishable. The page name comes from the shared nav table
 * (`matchNavTitleKey`) and is localized through the active i18n dictionary;
 * unmatched routes fall back to the default title. Re-runs when the dictionary
 * loads (via `t`), replacing any raw-key flash on cold boot.
 */
export function useDocumentTitle(): void {
    const { pathname } = useLocation();
    const { t } = useLanguage();

    useEffect(() => {
        const titleKey = matchNavTitleKey(pathname);
        document.title = titleKey ? `${t(titleKey)} · Vision` : DEFAULT_TITLE;
    }, [pathname, t]);
}
