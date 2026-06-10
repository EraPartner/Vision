import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isTypingTarget } from "@/lib/keyboard";

/** Gmail-style go-to sequences: press `g`, then a destination key.
 *  Shared with ShortcutsOverlay so the help sheet stays truthful. */
export const GO_TO_ROUTES: ReadonlyArray<{ key: string; url: string; titleKey: string }> = [
    { key: "d", url: "/", titleKey: "nav.dashboard" },
    { key: "t", url: "/transactions", titleKey: "nav.transactions" },
    { key: "s", url: "/statistics", titleKey: "nav.statistics" },
    { key: "c", url: "/categories", titleKey: "nav.categories" },
    { key: "r", url: "/recipients", titleKey: "nav.recipients" },
    { key: "i", url: "/import", titleKey: "nav.importExport" },
    { key: "p", url: "/portfolio", titleKey: "nav.portfolio" },
    { key: "n", url: "/portfolio/net-worth", titleKey: "nav.netWorth" },
    { key: "a", url: "/ai-chat", titleKey: "nav.aiChat" },
];

const SEQUENCE_WINDOW_MS = 900;

export function useGoToShortcuts(): void {
    const navigate = useNavigate();

    useEffect(() => {
        let armed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const disarm = () => {
            armed = false;
            if (timer) clearTimeout(timer);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) {
                disarm();
                return;
            }
            if (!armed) {
                if (e.key.toLowerCase() === "g") {
                    armed = true;
                    timer = setTimeout(disarm, SEQUENCE_WINDOW_MS);
                }
                return;
            }
            const target = GO_TO_ROUTES.find((r) => r.key === e.key.toLowerCase());
            disarm();
            if (target) {
                e.preventDefault();
                navigate(target.url);
            }
        };

        document.addEventListener("keydown", onKeyDown);
        return () => {
            disarm();
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [navigate]);
}
