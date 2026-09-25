import { useQuery } from "@tanstack/react-query";
import { getAgentCloakDesktopStatus } from "@/lib/api/aiResearch";

export const desktopStatusKey = ["ai", "agentcloak-desktop"] as const;

export function useAgentCloakDesktopStatus() {
    return useQuery({
        queryKey: desktopStatusKey,
        queryFn: getAgentCloakDesktopStatus,
        retry: 0,
    });
}
