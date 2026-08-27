import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useBlocker } from "react-router";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLanguage } from "@/contexts/LanguageContext";

interface UnsavedChangesContextValue {
    register: (id: string, dirty: boolean) => void;
    unregister: (id: string) => void;
    bypassNextNavigation: (id: string) => void;
}

const NOOP_CONTEXT: UnsavedChangesContextValue = {
    register: () => undefined,
    unregister: () => undefined,
    bypassNextNavigation: () => undefined,
};

const UnsavedChangesContext =
    createContext<UnsavedChangesContextValue>(NOOP_CONTEXT);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
    const { t } = useLanguage();
    const registrations = useRef(new Map<string, boolean>());
    const bypassRegistrationId = useRef<string | null>(null);
    const [dirtyCount, setDirtyCount] = useState(0);

    const updateCount = useCallback(() => {
        setDirtyCount(
            Array.from(registrations.current.values()).filter(Boolean).length,
        );
    }, []);

    const register = useCallback(
        (id: string, dirty: boolean) => {
            registrations.current.set(id, dirty);
            updateCount();
        },
        [updateCount],
    );

    const unregister = useCallback(
        (id: string) => {
            registrations.current.delete(id);
            updateCount();
        },
        [updateCount],
    );

    const bypassNextNavigation = useCallback((id: string) => {
        bypassRegistrationId.current = id;
    }, []);

    const hasUnsavedChanges = dirtyCount > 0;
    const blocker = useBlocker(({ currentLocation, nextLocation }) => {
        const bypassId = bypassRegistrationId.current;
        if (bypassId !== null) {
            bypassRegistrationId.current = null;
            const bypassIsDirty = registrations.current.get(bypassId) === true;
            const anotherRegistrationIsDirty = Array.from(
                registrations.current.entries(),
            ).some(([id, dirty]) => id !== bypassId && dirty);
            if (bypassIsDirty && !anotherRegistrationIsDirty) return false;
        }
        return (
            hasUnsavedChanges &&
            currentLocation.pathname !== nextLocation.pathname
        );
    });

    useEffect(() => {
        if (!hasUnsavedChanges && blocker.state === "blocked") {
            blocker.reset();
        }
    }, [blocker, hasUnsavedChanges]);

    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () =>
            window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [hasUnsavedChanges]);

    const value = useMemo(
        () => ({ register, unregister, bypassNextNavigation }),
        [bypassNextNavigation, register, unregister],
    );

    return (
        <UnsavedChangesContext.Provider value={value}>
            {children}
            <AlertDialog open={blocker.state === "blocked"}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {t("unsavedChanges.title")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("unsavedChanges.description")}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => blocker.reset?.()}>
                            {t("unsavedChanges.stay")}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={() => blocker.proceed?.()}>
                            {t("unsavedChanges.leave")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </UnsavedChangesContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUnsavedChanges(dirty: boolean): {
    bypassNextNavigation: () => void;
} {
    const id = useId();
    const context = useContext(UnsavedChangesContext);

    useEffect(() => {
        context.register(id, dirty);
        return () => context.unregister(id);
    }, [context, dirty, id]);

    const bypassNextNavigation = useCallback(
        () => context.bypassNextNavigation(id),
        [context, id],
    );

    return { bypassNextNavigation };
}
