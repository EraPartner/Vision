// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

function Harness({ onResolved }: { onResolved: (value: boolean) => void }) {
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const open = async () => {
        onResolved(
            await confirm({
                title: "Delete backup?",
                description: (
                    <>
                        This cannot be undone.
                        <strong>snapshot.visionbak</strong>
                    </>
                ),
                confirmLabel: "Delete",
                cancelLabel: "Keep",
                variant: "destructive",
            }),
        );
    };

    return (
        <>
            <button type="button" onClick={() => void open()}>
                Open
            </button>
            <ConfirmDialog />
        </>
    );
}

describe("useConfirmDialog", () => {
    it("renders ReactNode descriptions and resolves confirmation once", async () => {
        const onResolved = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<Harness onResolved={onResolved} />);

        await user.click(screen.getByRole("button", { name: "Open" }));
        expect(
            await screen.findByText("snapshot.visionbak"),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(onResolved).toHaveBeenCalledWith(true));
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it("resolves the explicit cancel action as false", async () => {
        const onResolved = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<Harness onResolved={onResolved} />);

        await user.click(screen.getByRole("button", { name: "Open" }));
        await user.click(await screen.findByRole("button", { name: "Keep" }));

        await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it("resolves an outside dismissal as false", async () => {
        const onResolved = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<Harness onResolved={onResolved} />);

        await user.click(screen.getByRole("button", { name: "Open" }));
        await screen.findByRole("alertdialog");
        await user.keyboard("{Escape}");

        await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
        expect(onResolved).toHaveBeenCalledTimes(1);
    });
});
