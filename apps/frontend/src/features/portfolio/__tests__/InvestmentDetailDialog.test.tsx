// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { InvestmentDetailDialog } from "@/features/portfolio/InvestmentDetailDialog";
import type { InvestmentSummary } from "@/types/portfolio";

// jsdom has no layout: the transactions list's scroll box measures 0px tall, so
// the real virtualizer mounts no rows at all. Render every item instead, the
// same stand-in VirtualDataTable's tests use, so these keep asserting the row
// markup and behaviour rather than the virtual window.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        getVirtualItems: () =>
            Array.from({ length: count }, (_, i) => ({
                key: i,
                index: i,
                start: i * estimateSize(),
                end: (i + 1) * estimateSize(),
                size: estimateSize(),
            })),
        getTotalSize: () => count * estimateSize(),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
    }),
}));

const API_BASE = "http://localhost:3002";

const TXN = {
    id: 101,
    investment_id: 1,
    type: "buy" as const,
    date: "2025-01-10",
    amount: 900,
    units: 10,
    price_per_unit: 90,
    fees: 2.5,
    taxes: 0,
    currency: "EUR",
    fx_rate_to_eur: 1,
    note: "Initial buy",
    is_recurring: false,
    created_at: "2025-01-10T10:00:00Z",
    updated_at: "2025-01-10T10:00:00Z",
};

const INVESTMENT: InvestmentSummary = {
    id: 1,
    name: "MSCI World ETF",
    symbol: "IWDA",
    asset_class: "etf",
    assetClass: "etf",
    currency: "EUR",
    current_price: 95.5,
    currentPrice: 95.5,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
    totalUnits: 10,
    totalInvested: 900,
    totalFees: 2.5,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 955,
    avgCostBasis: 90,
    realizedGain: 0,
    unrealizedGain: 55,
    totalGain: 55,
    gainLoss: 55,
    gainLossPercent: 6.1,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 902.5,
    totalSellProceeds: 0,
    transactions: [TXN],
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("InvestmentDetailDialog", () => {
    it("renders trigger button (Eye/Details button)", async () => {
        // Arrange + Act
        renderWithApp(
            <InvestmentDetailDialog investment={INVESTMENT} />,
        );

        // Assert — default trigger is an Eye icon "Details" button (invDetail.trigger = "Details")
        const trigger = await screen.findByRole("button", { name: /details/i });
        expect(trigger).toBeInTheDocument();
    });

    it("opens dialog on trigger click and shows investment name", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog investment={INVESTMENT} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));

        // Assert — dialog is open and investment name appears inside it
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toBeInTheDocument();
        // The name appears in both the dialog title and the sr-only description; use getAllByText
        const nameMatches = screen.getAllByText("MSCI World ETF");
        expect(nameMatches.length).toBeGreaterThan(0);
    });

    it("shows Performance tab content by default", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog investment={INVESTMENT} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        // Assert — "Performance" tab is selected by default (tab panel visible)
        const performanceTab = await screen.findByRole("tab", {
            name: /performance/i,
        });
        expect(performanceTab).toHaveAttribute("data-state", "active");
    });

    it("switching to Transactions tab shows transaction list", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog investment={INVESTMENT} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        const txnTab = await screen.findByRole("tab", { name: /transactions/i });
        await user.click(txnTab);

        // Assert — transaction note text appears in the list
        expect(await screen.findByText("Initial buy")).toBeInTheDocument();
    });

    it("close button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog investment={INVESTMENT} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        // DialogContent provides a Close button — accessible via its sr-only "Close" label
        const closeButton = screen.getByRole("button", { name: /^close$/i });
        await user.click(closeButton);

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("calls onAddTransaction callback when add transaction button is clicked", async () => {
        // Arrange
        const onAddTransaction = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={onAddTransaction}
                onEditInvestment={vi.fn()}
                onEditTransaction={vi.fn()}
            />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        // The add-transaction button renders the translated "Add Transaction" label.
        const addBtn = await screen.findByRole("button", {
            name: /add transaction/i,
        });
        await user.click(addBtn);

        // Assert
        expect(onAddTransaction).toHaveBeenCalledWith(INVESTMENT);
    });

    it("calls onEditInvestment callback when edit investment button is clicked", async () => {
        // Arrange
        const onEditInvestment = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={onEditInvestment}
                onEditTransaction={vi.fn()}
            />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        // common.edit = "Edit"
        const editBtn = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editBtn);

        // Assert
        expect(onEditInvestment).toHaveBeenCalledWith(INVESTMENT);
    });

    it("calls onEditTransaction callback when edit transaction button is clicked", async () => {
        // Arrange
        const onEditTransaction = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={vi.fn()}
                onEditTransaction={onEditTransaction}
            />,
        );

        // Act — navigate to Transactions tab first
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        const txnTab = await screen.findByRole("tab", { name: /transactions/i });
        await user.click(txnTab);

        const editBtn = await screen.findByRole("button", { name: /edit transaction/i });
        await user.click(editBtn);

        // Assert
        expect(onEditTransaction).toHaveBeenCalledWith(TXN, INVESTMENT);
    });

    it("delete transaction shows confirmation, then calls DELETE API on confirm", async () => {
        // Arrange
        server.use(
            http.delete(
                `${API_BASE}/api/investments/transactions/:id`,
                () => ok({ message: "deleted" }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={vi.fn()}
                onEditTransaction={vi.fn()}
            />,
        );

        // Act — open dialog, switch to Transactions tab
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        const txnTab = await screen.findByRole("tab", { name: /transactions/i });
        await user.click(txnTab);

        const deleteBtn = await screen.findByRole("button", { name: /delete transaction/i });
        await user.click(deleteBtn);

        // Assert — confirmation AlertDialog appears (useConfirmDialog renders AlertDialog)
        const confirmDialog = await screen.findByRole("alertdialog");
        expect(confirmDialog).toBeInTheDocument();

        // invDetail.delete.confirm = "Delete"
        const confirmBtn = await screen.findByRole("button", { name: /^delete$/i });
        await user.click(confirmBtn);

        // Assert — AlertDialog closes after confirmation
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
        );
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes the dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={vi.fn()}
                onEditTransaction={vi.fn()}
            />,
        );
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={vi.fn()}
                onEditTransaction={vi.fn()}
            />,
        );
        await user.click(await screen.findByRole("button", { name: /details/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    // ─── Nested dialogs (draft preservation) ────────────────────────────────
    //
    // The embedded Add/Edit dialogs used to be rendered inside this dialog's
    // own DialogContent, which Radix unmounts on close — so dismissing the
    // OUTER dialog destroyed the inner one's preserved draft (useDialogFormState
    // only survives while mounted). They are mounted alongside this dialog now
    // and driven by its state, which is what these pin.

    /** Open the detail dialog, then its embedded Add-transaction dialog. */
    async function openNestedAddDialog(user: ReturnType<typeof userEvent.setup>) {
        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");
        const opener = await screen.findByRole("button", { name: /^add transaction$/i });
        await user.click(opener);
        // addPortTxn.note = "Optional note..." — a field of the nested dialog only.
        return { opener, note: await screen.findByLabelText(/optional note/i) };
    }

    it("keeps a nested dialog's draft when the outer dialog is dismissed", async () => {
        const user = userEvent.setup();
        renderWithApp(<InvestmentDetailDialog investment={INVESTMENT} />);

        const { note } = await openNestedAddDialog(user);
        await user.type(note, "half-typed draft");

        // Dismiss the nested dialog, then the outer one — neither is a
        // deliberate exit (no Cancel, no submit), so nothing may be reset.
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByLabelText(/optional note/i)).not.toBeInTheDocument(),
        );
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        // Reopen both: the draft is still there.
        const reopened = await openNestedAddDialog(user);
        expect(reopened.note).toHaveValue("half-typed draft");
    });

    it("opens the embedded Edit dialogs from their in-dialog controls", async () => {
        const user = userEvent.setup();
        renderWithApp(<InvestmentDetailDialog investment={INVESTMENT} />);

        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");

        // These controls used to be the nested dialogs' own DialogTriggers.
        await user.click(screen.getByRole("button", { name: /^edit$/i }));
        expect((await screen.findAllByText("Edit Investment")).length).toBeGreaterThan(0);
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByText("Edit Investment")).not.toBeInTheDocument(),
        );

        await user.click(await screen.findByRole("tab", { name: /transactions/i }));
        await user.click(await screen.findByRole("button", { name: /edit transaction/i }));
        expect((await screen.findAllByText("Edit Transaction")).length).toBeGreaterThan(0);
    });

    it("returns focus to the control that opened a nested dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<InvestmentDetailDialog investment={INVESTMENT} />);

        // Lifted out of the outer content, the nested dialog has no
        // DialogTrigger of its own for Radix to hand focus back to.
        const { opener } = await openNestedAddDialog(user);
        await user.keyboard("{Escape}");

        await waitFor(() => expect(opener).toHaveFocus());
    });

    it("delete transaction error keeps dialog open and surfaces alert", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments/:id/transactions`, () =>
                ok({ items: [TXN], total: 1 }),
            ),
            http.delete(
                `${API_BASE}/api/investments/transactions/:id`,
                () => err(500, "delete failed"),
            ),
        );
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        renderWithApp(
            <InvestmentDetailDialog
                investment={INVESTMENT}
                onAddTransaction={vi.fn()}
                onEditInvestment={vi.fn()}
                onEditTransaction={vi.fn()}
            />,
        );

        await user.click(await screen.findByRole("button", { name: /details/i }));
        await screen.findByRole("dialog");
        const txnTab = await screen.findByRole("tab", { name: /transactions/i });
        await user.click(txnTab);

        const deleteBtn = await screen.findByRole("button", { name: /delete transaction/i });
        await user.click(deleteBtn);

        const confirmDialog = await screen.findByRole("alertdialog");
        expect(confirmDialog).toBeInTheDocument();
        const confirmBtn = await screen.findByRole("button", { name: /^delete$/i });
        await user.click(confirmBtn);

        // Investment dialog stays open on error
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        errSpy.mockRestore();
    });
});
