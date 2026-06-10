import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface PageTitleContextValue {
    title: string | null;
    setTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleContextValue>({
    title: null,
    setTitle: () => undefined,
});

/**
 * Carries the current page's title from PageHeader up to the topbar, enabling
 * the iOS large-title → inline-title collapse on scroll.
 */
export function PageTitleProvider({ children }: { children: ReactNode }) {
    const [title, setTitle] = useState<string | null>(null);
    const value = useMemo(() => ({ title, setTitle }), [title]);
    return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePageTitle(): PageTitleContextValue {
    return useContext(PageTitleContext);
}
