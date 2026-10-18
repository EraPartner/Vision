import type { DataRouter, Location, NavigateOptions, To } from "react-router";

export type NativeRouteIntent =
    | {
          kind: "navigate";
          to: To | null;
          options?: NavigateOptions & { fromRouteId?: string };
      }
    | { kind: "traverse"; delta: number };

export interface NativeRouteLocation {
    /** Exact source pathname + search. Hash and router state remain separate. */
    raw: string;
    pathname: string;
    search: string;
    hash: string;
    key: string;
    state: unknown;
}

export interface NativeRouteRequest {
    id: string;
    generation: string;
    source: "native" | "renderer";
    from: NativeRouteLocation;
    intent: NativeRouteIntent;
}

export interface NativeRouteCommit {
    request: NativeRouteRequest;
    location: NativeRouteLocation;
    historyAction: DataRouter["state"]["historyAction"];
}

/**
 * A preflight reservation, never a history write or draft discard. The host must
 * retain drafts until source acceptance. Releasing the lease only ends the reservation.
 */
export interface NativeRoutePreflightLease {
    release(outcome: "source-accepted" | "cancelled"): void;
}

export type NativeRouteResult =
    | { status: "committed"; commit: NativeRouteCommit }
    | { status: "unchanged" }
    | {
          status: "cancelled";
          reason:
              | "native-denied"
              | "web-stayed"
              | "superseded"
              | "origin-changed"
              | "disposed"
              | "in-flight";
      }
    | {
          status: "failed";
          stage: "preflight" | "router" | "commit";
          error: unknown;
          sourceAccepted?: NativeRouteCommit;
      };

export interface NativeRouteAdapterOptions {
    generation: string;
    preflight(
        request: NativeRouteRequest,
        signal: AbortSignal,
    ): Promise<NativeRoutePreflightLease | null>;
    commit(accepted: NativeRouteCommit): void | Promise<void>;
}

interface PendingRoute {
    request: NativeRouteRequest;
    controller: AbortController;
    phase: "preflight" | "routing" | "committing";
    sawWebBlocker: boolean;
    lease: NativeRoutePreflightLease | null;
    released: boolean;
    accepted?: NativeRouteCommit;
    resolve(result: NativeRouteResult): void;
}

function location(value: Location): NativeRouteLocation {
    return {
        raw: value.pathname + value.search,
        pathname: value.pathname,
        search: value.search,
        hash: value.hash,
        key: value.key,
        state: value.state as unknown,
    };
}

/**
 * Detached, opt-in request/acceptance foundation. App/RouterProvider does not install
 * it. Callers must explicitly route requests through it: existing useNavigate/Link,
 * fetchers and submissions are not intercepted, and window.history is never changed.
 *
 * The actual data router resolves relative/query/fromRouteId/state/replace/traverse
 * semantics and owns the sole UnsavedChangesProvider blocker. In particular, its
 * navigate promise resolving is not evidence that a blocked transition was accepted.
 *
 * This is not a complete native authority protocol: preflight sees the original
 * intent, not a guessed normalized target. Resolved-target admission, unified request
 * interception, host reservation/projection atomicity and generation-owned transport
 * remain prerequisites for activation. A commit callback failure cannot roll back
 * the already accepted source router location.
 * Correlation assumes no outside navigator supersedes a dispatched transaction;
 * a source subscription alone cannot prove ownership of unrelated direct traffic.
 */
export function createNativeRouteAdapter(
    router: DataRouter,
    options: NativeRouteAdapterOptions,
) {
    let sequence = 0;
    let disposed = false;
    let pending: PendingRoute | undefined;

    function release(
        item: PendingRoute,
        outcome: "source-accepted" | "cancelled",
    ) {
        if (!item.lease || item.released) return;
        item.released = true;
        item.lease.release(outcome);
    }

    function settle(item: PendingRoute, result: NativeRouteResult) {
        if (pending !== item) return;
        pending = undefined;
        item.resolve(result);
    }

    function cancel(
        item: PendingRoute,
        reason: Extract<NativeRouteResult, { status: "cancelled" }>["reason"],
    ) {
        if (pending !== item) return;
        pending = undefined;
        item.controller.abort();
        try {
            release(item, item.accepted ? "source-accepted" : "cancelled");
            item.resolve(
                item.accepted
                    ? {
                          status: "failed",
                          stage: "commit",
                          error: new Error(reason),
                          sourceAccepted: item.accepted,
                      }
                    : { status: "cancelled", reason },
            );
        } catch (error) {
            item.resolve({
                status: "failed",
                stage: item.accepted ? "commit" : "preflight",
                error,
                ...(item.accepted ? { sourceAccepted: item.accepted } : {}),
            });
        }
    }

    function observe(state: DataRouter["state"]) {
        const item = pending;
        if (!item || item.phase === "committing") return;
        if (item.phase === "preflight") {
            if (state.location.key !== item.request.from.key)
                cancel(item, "origin-changed");
            return;
        }
        if (state.location.key !== item.request.from.key) {
            const accepted: NativeRouteCommit = {
                request: item.request,
                location: location(state.location),
                historyAction: state.historyAction,
            };
            item.accepted = accepted;
            item.phase = "committing";
            // Dispatch is one-way. An accepted location is reported, never navigated to again.
            void Promise.resolve()
                .then(() => {
                    if (pending !== item) return;
                    release(item, "source-accepted");
                    return options.commit(accepted);
                })
                .then(
                    () =>
                        settle(item, { status: "committed", commit: accepted }),
                    (error: unknown) => {
                        settle(item, {
                            status: "failed",
                            stage: "commit",
                            error,
                            sourceAccepted: accepted,
                        });
                    },
                );
            return;
        }
        const blockers = Array.from(state.blockers.values());
        if (blockers.some((blocker) => blocker.state === "blocked"))
            item.sawWebBlocker = true;
        if (
            item.sawWebBlocker &&
            state.navigation.state === "idle" &&
            blockers.every((blocker) => blocker.state === "unblocked")
        )
            cancel(item, "web-stayed");
    }

    const unsubscribe = router.subscribe(observe);

    async function dispatch(item: PendingRoute) {
        try {
            item.lease = await options.preflight(
                item.request,
                item.controller.signal,
            );
            if (pending !== item) {
                // A host may complete its preflight even after AbortSignal cancellation.
                release(item, "cancelled");
                return;
            }
            if (!item.lease) {
                cancel(item, "native-denied");
                return;
            }
            if (router.state.location.key !== item.request.from.key) {
                cancel(item, "origin-changed");
                return;
            }
        } catch (error) {
            settle(item, { status: "failed", stage: "preflight", error });
            return;
        }
        item.phase = "routing";
        try {
            if (item.request.intent.kind === "traverse")
                await router.navigate(item.request.intent.delta);
            else
                await router.navigate(
                    item.request.intent.to,
                    item.request.intent.options,
                );
            if (pending !== item || pending.phase === "committing") return;
            observe(router.state);
            if (
                pending === item &&
                !item.sawWebBlocker &&
                router.state.navigation.state === "idle"
            ) {
                release(item, "cancelled");
                settle(item, { status: "unchanged" });
            }
        } catch (error) {
            if (pending !== item) return;
            try {
                release(item, "cancelled");
            } catch {
                /* Preserve the original source-router error. */
            }
            settle(item, { status: "failed", stage: "router", error });
        }
    }

    function request(
        intent: NativeRouteIntent,
        source: NativeRouteRequest["source"] = "native",
    ): Promise<NativeRouteResult> {
        if (disposed)
            return Promise.resolve({ status: "cancelled", reason: "disposed" });
        if (pending?.phase !== undefined && pending.phase !== "preflight") {
            // Do not reset/proceed the source blocker or misattribute an in-flight loader.
            return Promise.resolve({
                status: "cancelled",
                reason: "in-flight",
            });
        }
        if (intent.kind === "traverse" && !Number.isSafeInteger(intent.delta)) {
            return Promise.resolve({
                status: "failed",
                stage: "router",
                error: new Error("History delta must be a safe integer"),
            });
        }
        if (pending) cancel(pending, "superseded");
        const captured: NativeRouteIntent =
            intent.kind === "traverse"
                ? { ...intent }
                : {
                      ...intent,
                      to:
                          typeof intent.to === "object" && intent.to !== null
                              ? { ...intent.to }
                              : intent.to,
                      ...(intent.options
                          ? { options: { ...intent.options } }
                          : {}),
                  };
        return new Promise((resolve) => {
            const item: PendingRoute = {
                request: {
                    id: `${options.generation}:${++sequence}`,
                    generation: options.generation,
                    source,
                    from: location(router.state.location),
                    intent: captured,
                },
                controller: new AbortController(),
                phase: "preflight",
                sawWebBlocker: false,
                lease: null,
                released: false,
                resolve,
            };
            pending = item;
            void dispatch(item);
        });
    }

    return {
        request,
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            if (pending) cancel(pending, "disposed");
        },
    };
}
