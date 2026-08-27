// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";

const sonnerProps = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/ThemeContext", () => ({
    useTheme: () => ({ mode: "system" }),
}));

vi.mock("sonner", () => ({
    Toaster: (props: Record<string, unknown>) => {
        sonnerProps(props);
        return <div data-testid="sonner" />;
    },
    toast: {},
}));

describe("Toaster", () => {
    it("pins the documented Alt+T focus hotkey", () => {
        render(<Toaster />);

        expect(sonnerProps).toHaveBeenCalledWith(
            expect.objectContaining({ hotkey: ["altKey", "KeyT"] }),
        );
    });
});
