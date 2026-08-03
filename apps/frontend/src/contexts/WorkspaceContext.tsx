import { useCallback, useEffect } from "react";
import { useNavigate, useLocation } from "react-router";

export type Workspace = "budgeting" | "portfolio" | "research";

const WORKSPACE_KEY = "vision_workspace";

function readStoredWorkspace(): Workspace {
  try {
    const v = sessionStorage.getItem(WORKSPACE_KEY);
    if (v === "portfolio" || v === "budgeting" || v === "research") return v;
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
 * Derives the active workspace from the current route and provides a
 * navigate-based setter. Admin routes (/admin/*) are workspace-agnostic —
 * they preserve whichever workspace was active before entering admin.
 */
export function useWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();

  const path = location.pathname;
  const isPortfolio = path.startsWith("/portfolio");
  const isResearch = path.startsWith("/research");
  // Workspace-agnostic top-level routes preserve whichever workspace was active
  // (admin and the cross-workspace Accounts hub, ADR-088).
  const isAgnostic = path.startsWith("/admin") || path.startsWith("/accounts");

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
      } else if (ws === "budgeting" && (path.startsWith("/portfolio") || path.startsWith("/research") || path.startsWith("/admin") || path.startsWith("/accounts"))) {
        navigate("/");
      }
    },
    [navigate, path]
  );

  return { workspace, setWorkspace };
}
