// @vitest-environment jsdom
import { useState } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
    BackgroundQueryIndicator,
    useBackgroundQueryCue,
} from "@/components/shared/BackgroundQueryIndicator";
import {
    createLanguageQueryWrapper,
    createTestQueryClient,
} from "@/test/queryWrapper";

describe("BackgroundQueryIndicator", () => {
    it("shows only while a query with visible cached data refetches", async () => {
        const client = createTestQueryClient({ gcTime: Infinity });
        client.setQueryData(["cached"], { items: [1] });
        let finish: ((value: { items: number[] }) => void) | undefined;
        const refresh = client.fetchQuery({
            queryKey: ["cached"],
            queryFn: () =>
                new Promise<{ items: number[] }>((resolve) => {
                    finish = resolve;
                }),
        });

        render(<BackgroundQueryIndicator />, {
            wrapper: createLanguageQueryWrapper(client),
        });

        expect(
            await screen.findByTestId("background-query-indicator"),
        ).toHaveAttribute("aria-hidden", "true");
        expect(
            screen
                .getByTestId("background-query-indicator")
                .querySelector(".animate-shimmer"),
        ).toHaveClass("motion-reduce:hidden");

        await act(async () => {
            finish?.({ items: [1, 2] });
            await refresh;
        });
        await waitFor(() =>
            expect(
                screen.queryByTestId("background-query-indicator"),
            ).not.toBeInTheDocument(),
        );
    });

    it("does not replace a cold query's page-owned loading surface", async () => {
        const client = createTestQueryClient({ gcTime: Infinity });
        let finish: ((value: { items: number[] }) => void) | undefined;
        const initialLoad = client.fetchQuery({
            queryKey: ["cold"],
            queryFn: () =>
                new Promise<{ items: number[] }>((resolve) => {
                    finish = resolve;
                }),
        });

        render(<BackgroundQueryIndicator />, {
            wrapper: createLanguageQueryWrapper(client),
        });

        expect(
            screen.queryByTestId("background-query-indicator"),
        ).not.toBeInTheDocument();
        await act(async () => {
            finish?.({ items: [1] });
            await initialLoad;
        });
    });

    it("shows while a key change keeps the previous page as placeholder data", async () => {
        const client = createTestQueryClient({ gcTime: Infinity });
        let finishPageTwo!: (value: { page: number }) => void;
        const pageTwoResult = new Promise<{ page: number }>((resolve) => {
            finishPageTwo = resolve;
        });

        function PlaceholderList() {
            const [page, setPage] = useState(1);
            const result = useQuery({
                queryKey: [
                    "admin",
                    "db-table",
                    "transactions",
                    page,
                    "date",
                    {},
                ],
                queryFn: () =>
                    page === 1 ? Promise.resolve({ page: 1 }) : pageTwoResult,
                placeholderData: keepPreviousData,
                staleTime: Infinity,
            });
            useBackgroundQueryCue(
                result.isFetching && result.isPlaceholderData,
            );
            return (
                <>
                    <button type="button" onClick={() => setPage(2)}>
                        Next page
                    </button>
                    <output data-placeholder={result.isPlaceholderData}>
                        {result.data?.page}
                    </output>
                    <BackgroundQueryIndicator />
                </>
            );
        }

        render(<PlaceholderList />, {
            wrapper: createLanguageQueryWrapper(client),
        });
        expect(
            await screen.findByText("1", { selector: "output" }),
        ).toHaveAttribute("data-placeholder", "false");

        fireEvent.click(screen.getByRole("button", { name: "Next page" }));

        await waitFor(() => {
            expect(
                screen.getByText("1", { selector: "output" }),
            ).toHaveAttribute("data-placeholder", "true");
            expect(
                screen.getByTestId("background-query-indicator"),
            ).toBeInTheDocument();
        });

        finishPageTwo({ page: 2 });
        expect(
            await screen.findByText(
                "2",
                { selector: "output" },
                { timeout: 1_000 },
            ),
        ).toHaveAttribute("data-placeholder", "false");
        await waitFor(
            () =>
                expect(
                    screen.queryByTestId("background-query-indicator"),
                ).not.toBeInTheDocument(),
            { timeout: 1_000 },
        );
    });

    it("does not cue a fresh cold observer when another key variant is cached", async () => {
        const client = createTestQueryClient({ gcTime: Infinity });
        client.setQueryData(["categories", { active: true }], {
            items: ["cached"],
        });
        let finish!: (value: { items: string[] }) => void;
        const coldResult = new Promise<{ items: string[] }>((resolve) => {
            finish = resolve;
        });

        function FreshCategoryObserver() {
            const result = useQuery({
                queryKey: ["categories", { active: false }],
                queryFn: () => coldResult,
                placeholderData: keepPreviousData,
            });
            useBackgroundQueryCue(
                result.isFetching && result.isPlaceholderData,
            );
            return (
                <>
                    <output data-placeholder={result.isPlaceholderData}>
                        {result.fetchStatus}
                    </output>
                    <BackgroundQueryIndicator />
                </>
            );
        }

        render(<FreshCategoryObserver />, {
            wrapper: createLanguageQueryWrapper(client),
        });

        expect(
            await screen.findByText("fetching", { selector: "output" }),
        ).toHaveAttribute("data-placeholder", "false");
        expect(
            screen.queryByTestId("background-query-indicator"),
        ).not.toBeInTheDocument();

        await act(async () => finish({ items: ["fresh"] }));
    });

    it("does not treat an unrelated cached sibling as a placeholder cue", async () => {
        const client = createTestQueryClient({ gcTime: Infinity });
        client.setQueryData(["admin", "stats"], { ready: true });
        let finish: ((value: { ready: boolean }) => void) | undefined;
        const coldProviderHealth = client.fetchQuery({
            queryKey: ["admin", "provider-health"],
            queryFn: () =>
                new Promise<{ ready: boolean }>((resolve) => {
                    finish = resolve;
                }),
        });

        render(<BackgroundQueryIndicator />, {
            wrapper: createLanguageQueryWrapper(client),
        });

        expect(
            screen.queryByTestId("background-query-indicator"),
        ).not.toBeInTheDocument();
        await act(async () => {
            finish?.({ ready: true });
            await coldProviderHealth;
        });
    });
});
