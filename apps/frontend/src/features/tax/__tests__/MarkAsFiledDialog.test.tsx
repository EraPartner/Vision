// @vitest-environment jsdom
//
// Enter-to-submit regression tests (TODO.md: "Enter never submits in the
// button-only dialogs"). MarkAsFiledDialog is the simple representative: one
// text input + confirm/cancel footer, now wrapped in a real <form>. Enter in
// the reference field must file the year exactly once; Cancel must never file.
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { MarkAsFiledDialog } from "@/features/tax/MarkAsFiledDialog";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useSettingsStore } from "@/stores/settingsStore";
import { resolveBelgianTaxCalculation } from "@/stores/belgianTaxStore";

const YEAR = 2025;

/**
 * Context probe: renders the filed flag and the count of 'filed' audit entries.
 * The entry count is the double-submit detector — a submit firing twice
 * (button onClick + form onSubmit) would append two history entries.
 */
function FiledProbe() {
    const { isYearFiled, getSnapshotHistory } = useBelgianTaxProfile();
    const filedEntries = getSnapshotHistory(YEAR).filter((e) => e.kind === "filed");
    return (
        <div>
            <span data-testid="filed-state">{isYearFiled(YEAR) ? "filed" : "not-filed"}</span>
            <span data-testid="filed-count">{filedEntries.length}</span>
        </div>
    );
}

async function renderAndOpen(user: ReturnType<typeof userEvent.setup>) {
    renderWithApp(
        <>
            <MarkAsFiledDialog trigger={<button type="button">open filing</button>} year={YEAR} />
            <FiledProbe />
        </>,
    );
    await user.click(await screen.findByRole("button", { name: /open filing/i }));
    await screen.findByText(`Mark ${YEAR} as filed`);
}

describe("MarkAsFiledDialog — Enter submits the form", () => {
    it("files the year exactly once on Enter in the reference field", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "TOW-12345{Enter}");

        await waitFor(() =>
            expect(screen.getByTestId("filed-state")).toHaveTextContent("filed"),
        );
        // Exactly one 'filed' audit entry — no double submit.
        expect(screen.getByTestId("filed-count")).toHaveTextContent("1");
        // Confirm closes the dialog.
        expect(screen.queryByText(`Mark ${YEAR} as filed`)).not.toBeInTheDocument();
    });

    it("clicking the confirm button still files exactly once", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "PAPER-1");
        await user.click(screen.getByRole("button", { name: /mark as filed/i }));

        await waitFor(() =>
            expect(screen.getByTestId("filed-state")).toHaveTextContent("filed"),
        );
        expect(screen.getByTestId("filed-count")).toHaveTextContent("1");
    });

    it("cancel closes without filing", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "SHOULD-NOT-FILE");
        const cancel = screen.getByRole("button", { name: /cancel/i });
        expect(cancel).toHaveClass("border", "border-input/70");
        await user.click(cancel);

        await waitFor(() =>
            expect(screen.queryByText(`Mark ${YEAR} as filed`)).not.toBeInTheDocument(),
        );
        expect(screen.getByTestId("filed-state")).toHaveTextContent("not-filed");
        expect(screen.getByTestId("filed-count")).toHaveTextContent("0");
    });

    it("records the household and its result for a past year without a snapshot", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <MarkAsFiledDialog trigger={<button type="button">open filing</button>} year={YEAR} />,
        );
        await waitFor(() => {
            const state = useSettingsStore.getState();
            expect(state.isLoading).toBe(false);
            expect(state.household).not.toBeNull();
        });
        const live = useSettingsStore.getState().household!;
        expect(live.taxYear).not.toBe(YEAR);
        expect(useSettingsStore.getState().householdSnapshots[YEAR]).toBeUndefined();

        await user.click(screen.getByRole("button", { name: /open filing/i }));
        await user.click(await screen.findByRole("button", { name: /mark as filed/i }));

        await waitFor(() => expect(useSettingsStore.getState().isYearFiled(YEAR)).toBe(true));
        const state = useSettingsStore.getState();
        expect(state.householdSnapshots[YEAR]).toEqual({ ...live, taxYear: YEAR });
        expect(state.snapshotMetas[YEAR]?.frozenHouseholdResult?.incomeYear).toBe(YEAR);
        expect(state.snapshotMetas[YEAR]?.history?.map((e) => e.kind)).toEqual([
            "created",
            "filed",
        ]);
    });

    it("does not pin the live household over a year with a frozen calculation", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <MarkAsFiledDialog trigger={<button type="button">open filing</button>} year={YEAR} />,
        );
        await waitFor(() => {
            const state = useSettingsStore.getState();
            expect(state.isLoading).toBe(false);
            expect(state.household).not.toBeNull();
        });
        const before = useSettingsStore.getState();
        const frozenCalculation = {
            ...resolveBelgianTaxCalculation(before, YEAR),
            totalPIT: 12_345,
        };
        useSettingsStore.setState({
            snapshotMetas: {
                ...before.snapshotMetas,
                [YEAR]: { frozenCalculation, history: [] },
            },
        });

        await user.click(screen.getByRole("button", { name: /open filing/i }));
        await user.click(await screen.findByRole("button", { name: /mark as filed/i }));

        await waitFor(() => expect(useSettingsStore.getState().isYearFiled(YEAR)).toBe(true));
        const state = useSettingsStore.getState();
        expect(state.householdSnapshots[YEAR]).toBeUndefined();
        expect(state.snapshotMetas[YEAR]?.frozenCalculation?.totalPIT).toBe(12_345);
    });

    it("cancel discards a typed reference — reopening shows a blank field", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "SHOULD-NOT-SURVIVE");
        await user.click(screen.getByRole("button", { name: /cancel/i }));

        await waitFor(() =>
            expect(screen.queryByText(`Mark ${YEAR} as filed`)).not.toBeInTheDocument(),
        );

        await user.click(screen.getByRole("button", { name: /open filing/i }));
        await screen.findByText(`Mark ${YEAR} as filed`);

        expect(screen.getByLabelText("Reference")).toHaveValue("");
    });
});
