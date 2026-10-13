import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { registerNativePaletteAnswerBridge } from "@/lib/nativePaletteAnswer";

export function NativePaletteAnswerBridge() {
    const queryClient = useQueryClient();
    useEffect(() => registerNativePaletteAnswerBridge(queryClient), [queryClient]);
    return null;
}
