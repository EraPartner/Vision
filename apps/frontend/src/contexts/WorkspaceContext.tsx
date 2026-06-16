import { useCallback, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

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
  const isAdmin = path.startsWith("/admin");

  let workspace: Workspace;
  if (isAdmin) {
    workspace = readStoredWorkspace();
  } else if (isResearch) {
    workspace = "research";
  } else {
    workspace = isPortfolio ? "portfolio" : "budgeting";
  }

  useEffect(() => {
    if (!isAdmin) writeWorkspace(workspace);
  }, [isAdmin, workspace]);

  const setWorkspace = useCallback(
    (ws: Workspace) => {
      writeWorkspace(ws);
      if (ws === "portfolio" && !path.startsWith("/portfolio")) {
        navigate("/portfolio");
      } else if (ws === "research" && !path.startsWith("/research")) {
        navigate("/research");
      } else if (ws === "budgeting" && (path.startsWith("/portfolio") || path.startsWith("/research") || path.startsWith("/admin"))) {
        navigate("/");
      }
    },
    [navigate, path]
  );

  return { workspace, setWorkspace };
}
