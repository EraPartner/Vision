import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export type Workspace = "budgeting" | "portfolio";

interface WorkspaceContextValue {
  workspace: Workspace;
  setWorkspace: (ws: Workspace) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  // Derive workspace from current route
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

  return (
    <WorkspaceContext.Provider value={{ workspace, setWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
