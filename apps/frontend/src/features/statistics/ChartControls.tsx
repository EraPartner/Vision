import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ChartControlsContext } from "./chartControlsContext";

/** Keep local chart controls alongside the card's shared controls. */
export function ChartControls({ children }: { children: ReactNode }) {
    const target = useContext(ChartControlsContext);
    return target ? (
        createPortal(children, target)
    ) : (
        <div className="flex flex-wrap justify-end gap-2">{children}</div>
    );
}
