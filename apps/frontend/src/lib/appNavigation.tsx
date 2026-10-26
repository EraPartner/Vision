import { forwardRef } from "react";
import {
    Link,
    Navigate,
    NavLink,
    type LinkProps,
    type NavigateProps,
    type NavLinkProps,
} from "react-router";
import type { AppPath, AppPathname } from "@/lib/routes";

/**
 * Typed wrappers over react-router's navigation primitives. Their `to` is an
 * `AppPath`, so a route that does not exist fails to compile. Use these
 * instead of importing `Link`, `NavLink`, `Navigate` or `useNavigate` from
 * react-router (an ESLint rule enforces it); `useAppNavigate` lives in
 * hooks/useAppNavigate.
 */

export type AppLinkProps = Omit<LinkProps, "to"> & { to: AppPath };

export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(
    function AppLink(props, ref) {
        return <Link ref={ref} {...props} />;
    },
);

export type AppNavLinkProps = Omit<NavLinkProps, "to"> & { to: AppPath };

export const AppNavLink = forwardRef<HTMLAnchorElement, AppNavLinkProps>(
    function AppNavLink(props, ref) {
        return <NavLink ref={ref} {...props} />;
    },
);

export type AppNavigateProps = Omit<NavigateProps, "to"> & {
    to: AppPath | { pathname: AppPathname; search?: string; hash?: string };
};

export function AppNavigate(props: AppNavigateProps) {
    return <Navigate {...props} />;
}
