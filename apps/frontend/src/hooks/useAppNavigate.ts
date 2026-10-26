import { useCallback } from "react";
import { useNavigate, type NavigateOptions } from "react-router";
import type { AppPath } from "@/lib/routes";

export type AppNavigateFn = {
    (to: AppPath, options?: NavigateOptions): void | Promise<void>;
    /** History delta, e.g. `-1` for back. */
    (delta: number): void | Promise<void>;
};

/** Typed `useNavigate`: the target is an `AppPath`, so a missing route fails to compile. */
export function useAppNavigate(): AppNavigateFn {
    const navigate = useNavigate();
    return useCallback(
        (to: AppPath | number, options?: NavigateOptions) => {
            // Forward only what the caller passed, so calls match plain `useNavigate`.
            if (typeof to === "number") return navigate(to);
            return options === undefined ? navigate(to) : navigate(to, options);
        },
        [navigate],
    );
}
