import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const toastMock = vi.hoisted(() => {
    const success = vi.fn<(message: string, options: unknown) => number>(() => 7);
    const dismiss = vi.fn();
    return { success, dismiss };
});

vi.mock("sonner", () => ({
    toast: { success: toastMock.success, dismiss: toastMock.dismiss },
}));

import { consumeUndo } from "@/lib/undo";
import { undoToast } from "@/lib/undoToast";

describe("undoToast", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        toastMock.success.mockClear();
        toastMock.dismiss.mockClear();
    });

    afterEach(() => {
        consumeUndo();
        vi.useRealTimers();
    });

    test("shows a success toast with the Undo action and arms ⌘Z", () => {
        const undo = vi.fn();
        undoToast({ message: "Transaction deleted", undoLabel: "Undo", undo });
        expect(toastMock.success).toHaveBeenCalledWith(
            "Transaction deleted",
            expect.objectContaining({ duration: 8_000, action: expect.objectContaining({ label: "Undo" }) }),
        );
        expect(consumeUndo()).toBe(true);
        expect(undo).toHaveBeenCalledTimes(1);
        expect(toastMock.dismiss).toHaveBeenCalledWith(7);
    });

    test("pressing Undo in the toast clears the ⌘Z slot so the restore runs once", () => {
        const undo = vi.fn();
        undoToast({ message: "Deleted", undoLabel: "Undo", undo });
        const options = toastMock.success.mock.calls[0]?.[1] as unknown as {
            action: { onClick: () => void };
        };
        options.action.onClick();
        expect(undo).toHaveBeenCalledTimes(1);
        expect(consumeUndo()).toBe(false);
        expect(undo).toHaveBeenCalledTimes(1);
    });

    test("the ⌘Z slot expires with the toast", () => {
        const undo = vi.fn();
        undoToast({ message: "Deleted", undoLabel: "Undo", undo, ttlMs: 1_000 });
        vi.advanceTimersByTime(1_001);
        expect(consumeUndo()).toBe(false);
        expect(undo).not.toHaveBeenCalled();
    });
});
