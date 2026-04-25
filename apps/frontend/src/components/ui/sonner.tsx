import {useTheme} from "@/contexts/ThemeContext";
import {toast, Toaster as Sonner} from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({...props}: ToasterProps) => {
    const {mode = "system"} = useTheme();

    return (
        <Sonner
            theme={mode as ToasterProps["theme"]}
            className="toaster group"
            toastOptions={{
                classNames: {
                    toast:
                        "group toast group-[.toaster]:rounded-xl group-[.toaster]:border group-[.toaster]:border-border/50 group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:shadow-lg group-[.toaster]:tracking-tight",
                    title: "group-[.toast]:font-display group-[.toast]:text-sm group-[.toast]:font-semibold",
                    description: "group-[.toast]:text-muted-foreground/90",
                    actionButton:
                        "group-[.toast]:rounded-md group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:shadow-[0_4px_14px_-6px_hsl(var(--primary)/0.4)]",
                    cancelButton:
                        "group-[.toast]:rounded-md group-[.toast]:bg-foreground/[0.06] group-[.toast]:text-muted-foreground",
                    success: "group-[.toaster]:text-emerald-500",
                    error: "group-[.toaster]:text-red-500",
                },
            }}
            {...props}
        />
    );
};

export {Toaster, toast};
