// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    claimDashboardArrival,
    DASHBOARD_ARRIVAL_EVENT,
    requestDashboardArrival,
} from "@/utils/dashboardArrival";

describe("dashboard arrival motion gate", () => {
    beforeEach(() => window.sessionStorage.clear());

    it("allows the full reveal only once per session", () => {
        expect(claimDashboardArrival()).toBe(true);
        expect(claimDashboardArrival()).toBe(false);
    });

    it("reserves and announces a reveal after meaningful completion", () => {
        expect(claimDashboardArrival()).toBe(true);
        const listener = vi.fn();
        window.addEventListener(DASHBOARD_ARRIVAL_EVENT, listener);

        requestDashboardArrival();

        expect(listener).toHaveBeenCalledOnce();
        expect(claimDashboardArrival()).toBe(true);
        window.removeEventListener(DASHBOARD_ARRIVAL_EVENT, listener);
    });
});
