// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it, vi } from "vitest";
import { ScrollToTop } from "../ScrollToTop";

it("scrolls for a new page but preserves position for chart parameters and history", async () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const router = createMemoryRouter(
        [{ path: "*", element: <ScrollToTop /> }],
        { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/portfolio"));
    expect(scroll).toHaveBeenCalledTimes(1);
    await act(() => router.navigate("/portfolio?period=1y", { replace: true }));
    await act(() => router.navigate("/portfolio?period=3y"));
    expect(scroll).toHaveBeenCalledTimes(1);
    await act(() => router.navigate(-1));
    expect(scroll).toHaveBeenCalledTimes(1);
    await act(() => router.navigate("/transactions", { replace: true }));
    expect(scroll).toHaveBeenCalledTimes(2);
    await act(() => router.navigate(-1));
    expect(scroll).toHaveBeenCalledTimes(2);
    scroll.mockRestore();
});
