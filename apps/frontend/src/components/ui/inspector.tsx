import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

/**
 * Inspector panel (ADR-179): a non-modal details pane docked beside a list,
 * the way Finder and Mail show the selected item. It stays open while the
 * list is used, so it is a landmark (`complementary`), not a dialog: focus is
 * not trapped and the page behind stays interactive. Escape closes it when
 * focus is inside. Screens decide its width and when it is shown; a phone
 * layout can present the same content in a Sheet instead.
 */
export interface InspectorProps extends React.HTMLAttributes<HTMLElement> {
    /** Called when the user presses Escape inside the panel or its close button. */
    onClose?: () => void;
    /** Accessible name; falls back to `aria-labelledby` or the title. */
    "aria-label"?: string;
}

const Inspector = React.forwardRef<HTMLElement, InspectorProps>(
    ({ className, onClose, onKeyDown, ...props }, ref) => (
        <aside
            ref={ref}
            role="complementary"
            className={cn(
                "glass-regular flex min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-card corner-continuous",
                className,
            )}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (event.defaultPrevented || !onClose) return;
                if (event.key === "Escape") {
                    event.preventDefault();
                    onClose();
                }
            }}
            {...props}
        />
    ),
);
Inspector.displayName = "Inspector";

const InspectorHeader = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn(
            "flex items-start gap-3 border-b border-border/50 px-5 pb-3 pt-4",
            className,
        )}
        {...props}
    />
));
InspectorHeader.displayName = "InspectorHeader";

const InspectorTitle = React.forwardRef<
    HTMLHeadingElement,
    React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
    <h2
        ref={ref}
        className={cn("min-w-0 flex-1 truncate type-title-3 text-foreground", className)}
        {...props}
    />
));
InspectorTitle.displayName = "InspectorTitle";

const InspectorClose = React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, children, ...props }, ref) => {
    const { t } = useLanguage();
    return (
        <button
            ref={ref}
            type="button"
            className={cn(
                "-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-label-secondary transition-[background-color,color] duration-fast ease-glide hover:bg-foreground/[0.06] hover:text-foreground focus-ring",
                className,
            )}
            {...props}
        >
            {children ?? (
                <>
                    <X className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">{t("common.close")}</span>
                </>
            )}
        </button>
    );
});
InspectorClose.displayName = "InspectorClose";

const InspectorBody = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn("min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4", className)}
        {...props}
    />
));
InspectorBody.displayName = "InspectorBody";

export interface InspectorSectionProps
    extends React.HTMLAttributes<HTMLElement> {
    /** Section label, rendered in the eyebrow role. */
    label?: React.ReactNode;
}

const InspectorSection = React.forwardRef<HTMLElement, InspectorSectionProps>(
    ({ className, label, children, ...props }, ref) => (
        <section ref={ref} className={cn("space-y-2", className)} {...props}>
            {label && <h3 className="eyebrow">{label}</h3>}
            {children}
        </section>
    ),
);
InspectorSection.displayName = "InspectorSection";

/** Label/value pair inside a section; values are tabular for money. */
const InspectorField = ({
    label,
    children,
    className,
}: {
    label: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) => (
    <div className={cn("flex items-baseline justify-between gap-3 type-body", className)}>
        <dt className="shrink-0 text-label-secondary">{label}</dt>
        <dd className="min-w-0 truncate text-right text-foreground tabular-nums">
            {children}
        </dd>
    </div>
);
InspectorField.displayName = "InspectorField";

const InspectorFooter = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn(
            "flex items-center justify-end gap-2 border-t border-border/50 px-5 py-3",
            className,
        )}
        {...props}
    />
));
InspectorFooter.displayName = "InspectorFooter";

export {
    Inspector,
    InspectorHeader,
    InspectorTitle,
    InspectorClose,
    InspectorBody,
    InspectorSection,
    InspectorField,
    InspectorFooter,
};
