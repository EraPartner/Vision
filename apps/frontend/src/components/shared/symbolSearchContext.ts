import { createContext } from "react";

interface SymbolSearchListState {
  activeOptionId?: string | undefined;
  setActiveOptionId: (id: string) => void;
}

export const SymbolSearchListContext = createContext<SymbolSearchListState | null>(null);
