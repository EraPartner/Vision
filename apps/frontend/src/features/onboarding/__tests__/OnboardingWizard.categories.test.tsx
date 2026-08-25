// @vitest-environment jsdom

import { http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OnboardingWizard } from "../OnboardingWizard";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    },
}));

beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

describe("OnboardingWizard category creation", () => {
    it("keeps the category step retryable when one request fails", async () => {
        const user = userEvent.setup();
        let shouldFail = true;
        let requestCount = 0;
        server.use(
            http.post(`${API_BASE}/api/categories`, () => {
                requestCount += 1;
                if (shouldFail && requestCount === 1) {
                    return err(400, "category unavailable");
                }
                return ok({ id: requestCount, general: "Created", detail: null });
            }),
        );

        renderWithApp(<OnboardingWizard open onComplete={vi.fn()} />);
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));

        const createButton = await screen.findByRole("button", { name: /create 15 categories/i });
        await user.click(createButton);

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed: category unavailable"));
        expect(toast.success).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /create 15 categories/i })).toBeEnabled();

        shouldFail = false;
        requestCount = 0;
        await user.click(screen.getByRole("button", { name: /create 15 categories/i }));

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Created 15 categories"));
        expect(await screen.findByText("Categories created")).toBeInTheDocument();
    });
});
