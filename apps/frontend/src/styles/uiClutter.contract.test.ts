// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), "src", path), "utf8");
}

describe("UI clutter contracts", () => {
    it("keeps recurring advisories collapsed until requested", () => {
        const recurring = source("features/planned/RecurringDetectionPanel.tsx");
        expect(recurring).toContain("useState(false)");
        expect(recurring).toContain("aria-expanded={amountAlertsExpanded}");
        expect(recurring).toContain("aria-expanded={expanded}");
    });

    it("keeps match suggestions to one compact review action", () => {
        const suggestions = source("features/planned/MatchSuggestionsBanner.tsx");
        expect(suggestions).toContain("onReview(suggestions[0].planned.id)");
        expect(suggestions).not.toContain("suggestions.map(");
    });

    it("shows the global reminder only on the dashboard while leaving badge effects mounted", () => {
        const notification = source("components/notifications/UpcomingPaymentsNotification.tsx");
        expect(notification).toContain('pathname !== "/"');
        expect(notification.indexOf("setDockBadge(badgeCount)")).toBeLessThan(
            notification.indexOf('pathname !== "/"'),
        );
    });
});
