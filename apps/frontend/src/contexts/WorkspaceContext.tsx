import { useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export type Workspace = "budgeting" | "portfolio";

/**
 * Derives the active workspace from the current route and provides a
 * navigate-based setter. No Context or Provider needed — all state lives
 * in the router, which is already a context.
 */
export function useWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();

  const isPortfolio = location.pathname.startsWith("/portfolio");
  const workspace: Workspace = isPortfolio ? "portfolio" : "budgeting";

  const setWorkspace = useCallback(
    (ws: Workspace) => {
      if (ws === "portfolio" && !location.pathname.startsWith("/portfolio")) {
        navigate("/portfolio");
      } else if (ws === "budgeting" && location.pathname.startsWith("/portfolio")) {
        navigate("/");
      }
    },
    [navigate, location.pathname]
  );

  return { workspace, setWorkspace };
}
