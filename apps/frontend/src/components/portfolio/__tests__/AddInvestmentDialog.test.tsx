// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";

const API_BASE = "http://localhost:3002";

beforeEach(() => {
    server.use(
        http.post(`${API_BASE}/api/investments/:id/transactions`, () =>
            ok({ id: 1, type: "buy" }),
        ),
    );
});

afterEach(() => vi.restoreAllMocks());

describe("AddInvestmentDialog", () => {
    it("renders trigger button", async () => {
        // Arrange + Act
        renderWithApp(<AddInvestmentDialog />);

        // Assert
        expect(
            await screen.findByRole("button", { name: /add investment/i }),
        ).toBeInTheDocument();
    });

    it("clicking trigger opens dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add investment/i }));

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows asset type selector on first step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");

        // Assert — type selector heading and at least one asset class button
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^etf/i })).toBeInTheDocument();
    });

    it("selecting an asset class advances to details step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^etf/i }));

        // Assert — Name field appears on the details step
        expect(await screen.findByLabelText(/name \*/i)).toBeInTheDocument();
    });

    it("back button returns to type step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act — open, advance to details, click Back
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^etf/i }));
        await screen.findByLabelText(/name \*/i);
        await user.click(screen.getByRole("button", { name: /back/i }));

        // Assert — type selector is visible again
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
    });

    it("submitting with name creates investment and closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act — open, select ETF, fill name, uncheck initial purchase, submit
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^etf/i }));

        const nameInput = await screen.findByLabelText(/name \*/i);
        await user.type(nameInput, "MSCI World ETF");

        // Uncheck "Add initial purchase" to avoid the transaction call path
        const initialPurchaseSwitch = screen.getByRole("switch");
        if (initialPurchaseSwitch.getAttribute("aria-checked") === "true") {
            await user.click(initialPurchaseSwitch);
        }

        await user.click(screen.getByRole("button", { name: /^create$/i }));

        // Assert — dialog closes after success
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submit error shows dialog stays open", async () => {
        // Arrange
        server.use(
            http.post(`${API_BASE}/api/investments`, () => err(500, "insert failed")),
        );
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act — open, advance to details, fill name, uncheck initial purchase, submit
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^etf/i }));

        const nameInput = await screen.findByLabelText(/name \*/i);
        await user.type(nameInput, "Failed ETF");

        const initialPurchaseSwitch = screen.getByRole("switch");
        if (initialPurchaseSwitch.getAttribute("aria-checked") === "true") {
            await user.click(initialPurchaseSwitch);
        }

        await user.click(screen.getByRole("button", { name: /^create$/i }));

        // Assert — dialog stays open because the request errored
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("Escape key closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("cancel/close resets step — reopening shows type selector", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentDialog />);
        const triggerButton = await screen.findByRole("button", { name: /add investment/i });

        // Act — open, advance to details, close via Escape
        await user.click(triggerButton);
        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^etf/i }));
        await screen.findByLabelText(/name \*/i);
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        // Reopen
        await user.click(triggerButton);

        // Assert — type step is shown (not the details step)
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
    });
});
