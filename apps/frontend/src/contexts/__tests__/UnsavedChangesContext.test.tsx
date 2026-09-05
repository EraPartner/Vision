// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    Link,
    Outlet,
    RouterProvider,
    createMemoryRouter,
    useNavigate,
} from "react-router";

import {
    UnsavedChangesProvider,
    useUnsavedChanges,
} from "@/contexts/UnsavedChangesContext";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({
        t: (key: string) =>
            ({
                "unsavedChanges.title": "Leave this page?",
                "unsavedChanges.description": "Unsaved work",
                "unsavedChanges.stay": "Stay on page",
                "unsavedChanges.leave": "Leave and discard",
            })[key] ?? key,
    }),
}));

function Harness({ secondDirty = false }: { secondDirty?: boolean }) {
    const navigate = useNavigate();
    const [firstDirty, setFirstDirty] = useState(true);
    const first = useUnsavedChanges(firstDirty);
    useUnsavedChanges(secondDirty);
    return (
        <div>
            <Link to="/next">Next</Link>
            <button onClick={() => setFirstDirty(false)}>Clear draft</button>
            <button
                onClick={() => {
                    first.bypassNextNavigation();
                    navigate("/next");
                }}
            >
                Successful exit
            </button>
        </div>
    );
}

function renderRouter(secondDirty = false) {
    const router = createMemoryRouter(
        [
            {
                element: (
                    <UnsavedChangesProvider>
                        <Outlet />
                    </UnsavedChangesProvider>
                ),
                children: [
                    {
                        path: "/",
                        element: <Harness secondDirty={secondDirty} />,
                    },
                    { path: "/next", element: <div>Destination</div> },
                ],
            },
        ],
        { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    return router;
}

describe("UnsavedChangesProvider", () => {
    it("blocks route changes until the user confirms or stays", async () => {
        const user = userEvent.setup();
        const router = renderRouter();

        await user.click(screen.getByRole("link", { name: "Next" }));
        expect(screen.getByRole("alertdialog")).toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/");

        await user.click(screen.getByRole("button", { name: "Stay on page" }));
        expect(router.state.location.pathname).toBe("/");

        await user.click(screen.getByRole("link", { name: "Next" }));
        await user.click(
            screen.getByRole("button", { name: "Leave and discard" }),
        );
        expect(await screen.findByText("Destination")).toBeInTheDocument();
    });

    it("does not let one registration bypass another dirty draft", async () => {
        const user = userEvent.setup();
        const router = renderRouter(true);

        await user.click(
            screen.getByRole("button", { name: "Successful exit" }),
        );

        expect(screen.getByRole("alertdialog")).toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/");
    });

    it("supports a one-shot success bypass for the only dirty registration", async () => {
        const user = userEvent.setup();
        const router = renderRouter();

        await user.click(
            screen.getByRole("button", { name: "Successful exit" }),
        );

        expect(await screen.findByText("Destination")).toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/next");
    });

    it("resets a blocked transition when the final draft becomes clean", async () => {
        const user = userEvent.setup();
        const router = renderRouter();

        await user.click(screen.getByRole("link", { name: "Next" }));
        expect(screen.getByRole("alertdialog")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Clear draft"));

        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/");
    });

    it("prevents browser unload while any registration is dirty", () => {
        renderRouter();
        const event = new Event("beforeunload", { cancelable: true });

        window.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
    });
});
