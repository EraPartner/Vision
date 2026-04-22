import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Boot-time env validation (ADR-030): fail fast on misconfigured Vite vars.
import "./lib/env";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
