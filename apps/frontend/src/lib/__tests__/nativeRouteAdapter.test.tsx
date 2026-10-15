// @vitest-environment jsdom
import { useState } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    Link,
    Outlet,
    RouterProvider,
    createMemoryRouter,
    redirect,
} from "react-router";
import {
    UnsavedChangesProvider,
    useUnsavedChanges,
} from "@/contexts/UnsavedChangesContext";
import {
    createNativeRouteAdapter,
    type NativeRouteAdapterOptions,
    type NativeRouteIntent,
    type NativeRoutePreflightLease,
    type NativeRouteResult,
} from "@/lib/nativeRouteAdapter";

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

function Draft({
    dirty,
    secondDirty,
    exit,
}: {
    dirty: boolean;
    secondDirty: boolean;
    exit(): void;
}) {
    const [edited, setEdited] = useState(dirty);
    const draft = useUnsavedChanges(edited);
    useUnsavedChanges(secondDirty);
    return (
        <>
            <div>Draft page</div>
            <button onClick={() => setEdited(false)}>Clear draft</button>
            <button
                onClick={() => {
                    draft.bypassNextNavigation();
                    exit();
                }}
            >
                Successful exit
            </button>
            <Link to="/next">Direct source link</Link>
        </>
    );
}

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup({
    dirty = false,
    secondDirty = false,
    initialEntries = ["/"],
    preflight,
    commit,
    slow,
}: {
    dirty?: boolean;
    secondDirty?: boolean;
    initialEntries?: string[];
    preflight?: NativeRouteAdapterOptions["preflight"];
    commit?: NativeRouteAdapterOptions["commit"];
    slow?: Promise<null>;
} = {}) {
    const release = vi.fn();
    const preflightSpy = vi.fn(preflight ?? (async () => ({ release })));
    const commitSpy = vi.fn(commit ?? (() => {}));
    let exitResult: Promise<NativeRouteResult> | undefined;
    const router = createMemoryRouter(
        [
            {
                id: "root",
                element: (
                    <UnsavedChangesProvider>
                        <Outlet />
                    </UnsavedChangesProvider>
                ),
                children: [
                    {
                        id: "draft",
                        path: "/",
                        element: (
                            <Draft
                                dirty={dirty}
                                secondDirty={secondDirty}
                                exit={() => {
                                    exitResult = adapter.request({
                                        kind: "navigate",
                                        to: "/next",
                                    });
                                }}
                            />
                        ),
                    },
                    { path: "/first", element: <div>First page</div> },
                    { path: "/next", element: <div>Destination</div> },
                    {
                        path: "/slow",
                        loader: () => slow ?? null,
                        element: <div>Slow destination</div>,
                    },
                    {
                        path: "/redirect",
                        loader: () => redirect("/next?raw=a+b&x=%2f&flag"),
                    },
                    {
                        id: "workspace",
                        path: "/workspace",
                        element: <Outlet />,
                        children: [
                            {
                                id: "report",
                                path: "reports/:id",
                                element: <div>Report</div>,
                            },
                            { path: "archive", element: <div>Archive</div> },
                        ],
                    },
                ],
            },
        ],
        { initialEntries },
    );
    const adapter = createNativeRouteAdapter(router, {
        generation: "document-7",
        preflight: preflightSpy,
        commit: commitSpy,
    });
    cleanups.push(() => {
        adapter.dispose();
        router.dispose();
    });
    render(<RouterProvider router={router} />);
    return {
        adapter,
        router,
        release,
        preflight: preflightSpy,
        commit: commitSpy,
        exitResult: () => exitResult,
    };
}

async function start(
    adapter: ReturnType<typeof createNativeRouteAdapter>,
    intent: NativeRouteIntent,
) {
    let result!: Promise<NativeRouteResult>;
    await act(async () => {
        result = adapter.request(intent);
        await Promise.resolve();
    });
    return { result };
}

describe("detached native route request/acceptance foundation", () => {
    it("waits for native preflight and the actual source Leave action before emitting one commit", async () => {
        const approval = deferred<NativeRoutePreflightLease | null>();
        const release = vi.fn();
        const page = setup({ dirty: true, preflight: () => approval.promise });
        const navigation = vi.spyOn(page.router, "navigate");
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/next?raw=a+b&x=%2f&flag",
        });
        expect(navigation).not.toHaveBeenCalled();
        expect(page.commit).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        await act(async () => {
            approval.resolve({ release });
        });
        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        expect(page.router.state.location.pathname).toBe("/");
        expect(page.commit).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByText("Leave and discard"));
        });
        const result = await pending.result;
        expect(result.status).toBe("committed");
        expect(page.commit).toHaveBeenCalledTimes(1);
        expect(page.commit.mock.calls[0]?.[0].location.raw).toBe(
            "/next?raw=a+b&x=%2f&flag",
        );
        expect(page.commit.mock.calls[0]?.[0].request.id).toBe("document-7:1");
        expect(release).toHaveBeenCalledExactlyOnceWith("source-accepted");
        expect(navigation).toHaveBeenCalledTimes(1); // blocker.proceed uses the source router's internal navigate.
    });

    it("keeps the source location and native commit callback untouched on native denial", async () => {
        const page = setup({ dirty: true, preflight: async () => null });
        const denied = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        expect(await denied.result).toEqual({
            status: "cancelled",
            reason: "native-denied",
        });
        expect(page.router.state.location.pathname).toBe("/");
        expect(page.commit).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("releases its preflight reservation when the source user stays", async () => {
        const page = setup({ dirty: true });
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByText("Stay on page"));
        });
        expect(await pending.result).toEqual({
            status: "cancelled",
            reason: "web-stayed",
        });
        expect(page.router.state.location.pathname).toBe("/");
        expect(page.commit).not.toHaveBeenCalled();
        expect(page.release).toHaveBeenCalledExactlyOnceWith("cancelled");
    });

    it("treats the source provider resetting a newly clean draft as cancellation", async () => {
        const page = setup({ dirty: true });
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByText("Clear draft"));
        });
        expect(await pending.result).toEqual({
            status: "cancelled",
            reason: "web-stayed",
        });
        expect(page.router.state.location.pathname).toBe("/");
        expect(page.commit).not.toHaveBeenCalled();
        expect(page.release).toHaveBeenCalledExactlyOnceWith("cancelled");
    });

    it("lets the source blocker cancel and then accept the same Back traversal", async () => {
        const page = setup({
            dirty: true,
            initialEntries: ["/next?first=a+b&flag", "/"],
        });
        const first = await start(page.adapter, {
            kind: "traverse",
            delta: -1,
        });
        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        expect(page.router.state.location.pathname).toBe("/");
        expect(page.commit).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByText("Stay on page"));
        });
        expect(await first.result).toEqual({
            status: "cancelled",
            reason: "web-stayed",
        });
        const second = await start(page.adapter, {
            kind: "traverse",
            delta: -1,
        });
        await act(async () => {
            fireEvent.click(await screen.findByText("Leave and discard"));
        });
        expect((await second.result).status).toBe("committed");
        expect(page.commit.mock.calls[0]?.[0].historyAction).toBe("POP");
        expect(page.commit.mock.calls[0]?.[0].location.raw).toBe(
            "/next?first=a+b&flag",
        );
        expect(page.commit).toHaveBeenCalledTimes(1);
    });

    it("preserves query-only replacement and arbitrary router state without prompting a path guard", async () => {
        const page = setup({ dirty: true });
        const state = {
            selectTransactionId: 12,
            optional: undefined,
            nested: { draft: true },
        };
        const options = {
            replace: true,
            state,
            fromRouteId: "draft",
            preventScrollReset: true,
        };
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: { search: "?settings=backup&q=a+b&x=%2f&flag" },
            options,
        });
        expect((await pending.result).status).toBe("committed");
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(page.router.state.location.search).toBe(
            "?settings=backup&q=a+b&x=%2f&flag",
        );
        expect(page.router.state.location.state).toBe(state);
        const accepted = page.commit.mock.calls[0]?.[0];
        expect(accepted?.historyAction).toBe("REPLACE");
        expect(accepted?.location.state).toBe(state);
        expect(accepted?.request.intent).toEqual({
            kind: "navigate",
            to: { search: "?settings=backup&q=a+b&x=%2f&flag" },
            options,
        });
    });

    it.each([
        [
            { relative: "route" as const, fromRouteId: "report" },
            "../archive",
            "/workspace/archive",
        ],
        [
            { relative: "path" as const, fromRouteId: "report" },
            "../archive",
            "/workspace/reports/archive",
        ],
        [{ fromRouteId: "workspace" }, "archive", "/workspace/archive"],
    ])(
        "delegates relative and route-context resolution to the real router (%j)",
        async (options, to, expected) => {
            const page = setup({
                initialEntries: ["/workspace/reports/7?keep=a+b"],
            });
            const pending = await start(page.adapter, {
                kind: "navigate",
                to,
                options,
            });
            expect((await pending.result).status).toBe("committed");
            expect(page.commit.mock.calls[0]?.[0].location.pathname).toBe(
                expected,
            );
        },
    );

    it("preserves replace and Back/Forward visits instead of projecting speculative history", async () => {
        const page = setup({
            initialEntries: ["/first?q=a+b&flag", "/?keep=1"],
        });
        const go = async (intent: NativeRouteIntent) => {
            const next = await start(page.adapter, intent);
            return await next.result;
        };
        expect(
            (await go({ kind: "navigate", to: "?settings=general" })).status,
        ).toBe("committed");
        expect(
            (
                await go({
                    kind: "navigate",
                    to: "?settings=about",
                    options: { replace: true },
                })
            ).status,
        ).toBe("committed");
        expect((await go({ kind: "traverse", delta: -1 })).status).toBe(
            "committed",
        );
        expect(page.router.state.location.search).toBe("?keep=1");
        expect((await go({ kind: "traverse", delta: -1 })).status).toBe(
            "committed",
        );
        expect(
            page.router.state.location.pathname +
                page.router.state.location.search,
        ).toBe("/first?q=a+b&flag");
        await go({ kind: "traverse", delta: 1 });
        await go({ kind: "traverse", delta: 1 });
        expect(page.router.state.location.search).toBe("?settings=about");
        expect(
            page.commit.mock.calls.map(([commit]) => commit.historyAction),
        ).toEqual(["PUSH", "REPLACE", "POP", "POP", "POP", "POP"]);
        expect((await go({ kind: "traverse", delta: 0 })).status).toBe(
            "unchanged",
        );
        expect(page.commit).toHaveBeenCalledTimes(6);
    });

    it("reports only the source loader redirect's accepted location without a feedback navigation", async () => {
        const page = setup();
        const navigation = vi.spyOn(page.router, "navigate");
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/redirect",
        });
        expect((await pending.result).status).toBe("committed");
        expect(page.commit).toHaveBeenCalledTimes(1);
        expect(page.commit.mock.calls[0]?.[0].request.intent).toEqual({
            kind: "navigate",
            to: "/redirect",
        });
        expect(page.commit.mock.calls[0]?.[0].location.raw).toBe(
            "/next?raw=a+b&x=%2f&flag",
        );
        expect(navigation).toHaveBeenCalledExactlyOnceWith(
            "/redirect",
            undefined,
        );
    });

    it("holds a dispatched loader and refuses another request instead of resetting its source guards", async () => {
        const loader = deferred<null>();
        const page = setup({ slow: loader.promise });
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/slow",
        });
        await waitFor(() =>
            expect(page.router.state.navigation.state).toBe("loading"),
        );
        expect(page.commit).not.toHaveBeenCalled();
        expect(page.release).not.toHaveBeenCalled();
        expect(
            await page.adapter.request({ kind: "navigate", to: "/next" }),
        ).toEqual({ status: "cancelled", reason: "in-flight" });
        await act(async () => {
            loader.resolve(null);
        });
        expect((await pending.result).status).toBe("committed");
        expect(page.commit.mock.calls[0]?.[0].location.pathname).toBe("/slow");
        expect(page.preflight).toHaveBeenCalledTimes(1);
    });

    it("supersedes a preflight and cancels its late lease without committing its stale location", async () => {
        const older = deferred<NativeRoutePreflightLease | null>();
        const releaseOld = vi.fn();
        const releaseNew = vi.fn();
        const page = setup({
            preflight: (request) =>
                request.id.endsWith(":1")
                    ? older.promise
                    : Promise.resolve({ release: releaseNew }),
        });
        const first = await start(page.adapter, {
            kind: "navigate",
            to: "/first",
        });
        const second = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        expect(await first.result).toEqual({
            status: "cancelled",
            reason: "superseded",
        });
        expect((await second.result).status).toBe("committed");
        expect(page.preflight.mock.calls[0]?.[1]?.aborted).toBe(true);
        await act(async () => {
            older.resolve({ release: releaseOld });
        });
        expect(releaseOld).toHaveBeenCalledExactlyOnceWith("cancelled");
        expect(releaseNew).toHaveBeenCalledExactlyOnceWith("source-accepted");
        expect(page.commit).toHaveBeenCalledTimes(1);
        expect(page.router.state.location.pathname).toBe("/next");
    });

    it("rejects a stale relative origin and releases a lease that arrives after disposal", async () => {
        const older = deferred<NativeRoutePreflightLease | null>();
        const release = vi.fn();
        const page = setup({ preflight: () => older.promise });
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "?settings=general",
        });
        await act(async () => {
            await page.router.navigate("/next");
        });
        expect(await pending.result).toEqual({
            status: "cancelled",
            reason: "origin-changed",
        });
        page.adapter.dispose();
        await act(async () => {
            older.resolve({ release });
        });
        expect(release).toHaveBeenCalledExactlyOnceWith("cancelled");
        expect(page.commit).not.toHaveBeenCalled();
        expect(
            await page.adapter.request({ kind: "traverse", delta: -1 }),
        ).toEqual({ status: "cancelled", reason: "disposed" });
    });

    it("disposes a pending native preflight without a router call", async () => {
        const approval = deferred<NativeRoutePreflightLease | null>();
        const release = vi.fn();
        const page = setup({ preflight: () => approval.promise });
        const navigation = vi.spyOn(page.router, "navigate");
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        page.adapter.dispose();
        expect(await pending.result).toEqual({
            status: "cancelled",
            reason: "disposed",
        });
        await act(async () => {
            approval.resolve({ release });
        });
        expect(release).toHaveBeenCalledExactlyOnceWith("cancelled");
        expect(navigation).not.toHaveBeenCalled();
        expect(page.commit).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "retains the source one-shot bypass and another draft's veto (second draft: %s)",
        async (secondDirty) => {
            const page = setup({ dirty: true, secondDirty });
            await act(async () => {
                fireEvent.click(screen.getByText("Successful exit"));
            });
            if (secondDirty) {
                expect(
                    await screen.findByRole("alertdialog"),
                ).toBeInTheDocument();
                expect(page.commit).not.toHaveBeenCalled();
                await act(async () => {
                    fireEvent.click(screen.getByText("Stay on page"));
                });
                expect(await page.exitResult()).toEqual({
                    status: "cancelled",
                    reason: "web-stayed",
                });
            } else {
                expect(
                    await screen.findByText("Destination"),
                ).toBeInTheDocument();
                expect((await page.exitResult())?.status).toBe("committed");
            }
        },
    );

    it("reports a failed host commit as source-accepted rather than pretending to roll back", async () => {
        const failure = new Error("Host acknowledgement failed");
        const page = setup({
            commit: () => {
                throw failure;
            },
        });
        const pending = await start(page.adapter, {
            kind: "navigate",
            to: "/next",
        });
        const result = await pending.result;
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
            expect(result.stage).toBe("commit");
            expect(result.error).toBe(failure);
            expect(result.sourceAccepted?.location.pathname).toBe("/next");
        }
        expect(page.router.state.location.pathname).toBe("/next");
        expect(page.commit).toHaveBeenCalledTimes(1);
        expect(page.release).toHaveBeenCalledExactlyOnceWith("source-accepted");
    });

    it("does not activate interception for an existing Link", async () => {
        const page = setup();
        await act(async () => {
            fireEvent.click(
                screen.getByRole("link", { name: "Direct source link" }),
            );
        });
        expect(await screen.findByText("Destination")).toBeInTheDocument();
        expect(page.preflight).not.toHaveBeenCalled();
        expect(page.commit).not.toHaveBeenCalled();
    });
});
