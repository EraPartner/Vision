// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { RecurringDetectionPanel } from "@/features/planned/RecurringDetectionPanel";

const API_BASE = "http://localhost:3002";

/**
 * Sign convention pin (planned-payments): money OUT is negative, money IN is
 * positive. The detection service .abs()'s every amount server-side and carries
 * the flow sign only in `direction` — the panel must recombine them, or a
 * detected income (salary, rent received) becomes a negative planned payment
 * that plannedMatchService can never auto-match against the real positive
 * transaction.
 */
function patternFixture(direction: "income" | "expense") {
    return {
        recipientId: direction === "income" ? 7 : 8,
        recipientName: direction === "income" ? "Employer NV" : "Landlord SA",
        direction,
        detectedPattern: "monthly",
        intervalDays: 30,
        consistency: 95,
        occurrences: 6,
        averageAmount: 2500, // .abs()'d server-side — always positive on the wire
        latestAmount: 2500,
        currency: "EUR",
        categoryId: null,
        categoryName: null,
        bankAccount: "BE12",
        firstSeen: "2025-01-28",
        lastSeen: "2025-06-28",
        predictedNext: "2025-07-28",
        amountChanges: [],
        isAlreadyPlanned: false,
        confidence: 90,
    };
}

function servePatternsAndCapturePost(direction: "income" | "expense") {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    server.use(
        http.get(`${API_BASE}/api/info/recurring-patterns`, () =>
            ok({ patterns: [patternFixture(direction)], total: 1 }),
        ),
        http.post(`${API_BASE}/api/planned-transactions`, async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return ok({ id: 99 });
        }),
    );
    return captured;
}

async function clickTrack(user: ReturnType<typeof userEvent.setup>) {
    const trackBtn = await screen.findByRole("button", { name: /track/i });
    await user.click(trackBtn);
}

describe("RecurringDetectionPanel — detected sign carried into the planned payment", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("creates a POSITIVE planned amount for a detected income pattern", async () => {
        const user = userEvent.setup();
        const captured = servePatternsAndCapturePost("income");

        renderWithApp(<RecurringDetectionPanel />);

        expect(await screen.findByText("Employer NV")).toBeInTheDocument();
        await clickTrack(user);

        await waitFor(() => expect(captured.body).not.toBeNull());
        expect(captured.body).toMatchObject({
            amount: 2500, // income → positive, auto-matchable against the credit
            recipient_id: 7,
            currency: "EUR",
            planned_date: "2025-07-28",
            is_recurring: true,
            recurrence_pattern: "monthly",
        });
    });

    it("creates a NEGATIVE planned amount for a detected expense pattern", async () => {
        const user = userEvent.setup();
        const captured = servePatternsAndCapturePost("expense");

        renderWithApp(<RecurringDetectionPanel />);

        expect(await screen.findByText("Landlord SA")).toBeInTheDocument();
        await clickTrack(user);

        await waitFor(() => expect(captured.body).not.toBeNull());
        expect(captured.body).toMatchObject({
            amount: -2500, // expense → negative, auto-matchable against the debit
            recipient_id: 8,
        });
    });
});
