import { createContext } from "react";

interface SymbolSearchListState {
  activeOptionId?: string;
  setActiveOptionId: (id: string) => void;
}

export const SymbolSearchListContext = createContext<SymbolSearchListState | null>(null);
