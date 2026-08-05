import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {X} from "lucide-react";

import {cn} from "@/lib/utils";
import {composeRefs, useGenieOrigin} from "@/lib/dialogGenie";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({className, ...props}, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            // modal-overlay (index.css): plain dim by default, frosted blur only
            // at the fx-enhanced visual-effects tier (ADR-075).
            "modal-overlay fixed inset-0 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className,
        )}
        {...props}
    />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({className, children, ...props}, ref) => {
    const genieRef = useGenieOrigin();
    return (
    <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
            ref={composeRefs(ref, genieRef)}
            className={cn(
                "glass-thick fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-5 rounded-2xl p-6 shadow-glass-elevated data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out data-[state=closed]:[transform-origin:var(--genie-origin,50%_50%)] motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none",
                className,
            )}
            {...props}
        >
            {children}
            <DialogPrimitive.Close
                className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground opacity-70 ring-offset-background transition-[opacity,background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-glide)] hover:bg-foreground/[0.06] hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:pointer-events-none">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
        </DialogPrimitive.Content>
    </DialogPortal>
    );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({className, ...props}: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({className, ...props}: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({className, ...props}, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn("font-display text-xl font-semibold leading-tight tracking-tight text-foreground", className)}
        {...props}
    />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({className, ...props}, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn("text-sm text-muted-foreground/90 tracking-tight", className)}
        {...props}
    />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
    Dialog,
    DialogPortal,
    DialogOverlay,
    DialogClose,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogTitle,
    DialogDescription,
};
