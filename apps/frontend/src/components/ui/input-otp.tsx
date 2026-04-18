import * as React from "react";
import {OTPInput, OTPInputContext} from "input-otp";
import {Dot} from "lucide-react";

import {cn} from "@/lib/utils";

const InputOTP = React.forwardRef<React.ElementRef<typeof OTPInput>, React.ComponentPropsWithoutRef<typeof OTPInput>>(
    ({className, containerClassName, ...props}, ref) => (
        <OTPInput
            ref={ref}
            containerClassName={cn("flex items-center gap-2 has-[:disabled]:opacity-50", containerClassName)}
            className={cn("disabled:cursor-not-allowed", className)}
            {...props}
        />
    ),
);
InputOTP.displayName = "InputOTP";

const InputOTPGroup = React.forwardRef<React.ElementRef<"div">, React.ComponentPropsWithoutRef<"div">>(
    ({className, ...props}, ref) => <div ref={ref} className={cn("flex items-center", className)} {...props} />,
);
InputOTPGroup.displayName = "InputOTPGroup";

const InputOTPSlot = React.forwardRef<
    React.ElementRef<"div">,
    React.ComponentPropsWithoutRef<"div"> & { index: number }
>(({index, className, ...props}, ref) => {
    const inputOTPContext = React.useContext(OTPInputContext);
    const {char, hasFakeCaret, isActive} = inputOTPContext.slots[index];

    return (
        <div
            ref={ref}
            className={cn(
                "relative flex h-11 w-11 items-center justify-center border-y border-r border-border/60 bg-background/40 text-base font-medium tracking-wide transition-all duration-[var(--duration-fast)] first:rounded-l-lg first:border-l last:rounded-r-lg",
                isActive && "z-10 border-primary/50 bg-primary/5 ring-2 ring-ring/70 ring-offset-2 ring-offset-background",
                className,
            )}
            {...props}
        >
            {char}
            {hasFakeCaret && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="animate-caret-blink h-5 w-px bg-primary duration-1000"/>
                </div>
            )}
        </div>
    );
});
InputOTPSlot.displayName = "InputOTPSlot";

const InputOTPSeparator = React.forwardRef<React.ElementRef<"div">, React.ComponentPropsWithoutRef<"div">>(
    ({...props}, ref) => (
        <div ref={ref} role="separator" {...props}>
            <Dot/>
        </div>
    ),
);
InputOTPSeparator.displayName = "InputOTPSeparator";

export {InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator};
