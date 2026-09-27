import { useCallback, useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import { WORKSPACE_AGNOSTIC_URLS } from "@/lib/navigation";

export type Workspace = "budgeting" | "portfolio" | "research";

const WORKSPACE_KEY = "vision_workspace";

function readStoredWorkspace(): Workspace {
    try {
        const v = sessionStorage.getItem(WORKSPACE_KEY);
        if (v === "portfolio" || v === "budgeting" || v === "research")
            return v;
    } catch {
        // sessionStorage unavailable (private mode, SSR) — fall through to default
    }
    return "budgeting";
}

function writeWorkspace(ws: Workspace) {
    try {
        sessionStorage.setItem(WORKSPACE_KEY, ws);
    } catch {
        // sessionStorage unavailable — workspace persistence disabled this session
    }
}

/**
 * Router-backed hook that derives the active workspace and provides a
 * navigate-based setter. Global and admin routes preserve whichever
 * workspace was active before entering them.
 */
export function useWorkspace() {
    const location = useLocation();
    const navigate = useNavigate();

    const path = location.pathname;
    const isPortfolio = path.startsWith("/portfolio");
    const isResearch = path.startsWith("/research");
    // Share global routes with the navigation registry so new global pages
    // cannot silently reset the active workspace and its sidebar.
    const isAgnostic =
        path === "/admin" ||
        path.startsWith("/admin/") ||
        [...WORKSPACE_AGNOSTIC_URLS].some(
            (url) => path === url || path.startsWith(`${url}/`),
        );

    let workspace: Workspace;
    if (isAgnostic) {
        workspace = readStoredWorkspace();
    } else if (isResearch) {
        workspace = "research";
    } else {
        workspace = isPortfolio ? "portfolio" : "budgeting";
    }

    useEffect(() => {
        if (!isAgnostic) writeWorkspace(workspace);
    }, [isAgnostic, workspace]);

    const setWorkspace = useCallback(
        (ws: Workspace) => {
            writeWorkspace(ws);
            if (ws === "portfolio" && !path.startsWith("/portfolio")) {
                navigate("/portfolio");
            } else if (ws === "research" && !path.startsWith("/research")) {
                navigate("/research");
            } else if (
                ws === "budgeting" &&
                (path.startsWith("/portfolio") ||
                    path.startsWith("/research") ||
                    isAgnostic)
            ) {
                navigate("/");
            }
        },
        [navigate, path, isAgnostic],
    );

    return { workspace, setWorkspace };
}
