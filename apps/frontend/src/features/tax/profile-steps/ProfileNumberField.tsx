import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import {
    ProfileNumberInput,
    type ProfileNumberInputProps,
} from "./ProfileNumberInput";
import { FieldHint } from "./ProfileRows";

interface ProfileNumberFieldProps extends ProfileNumberInputProps {
    label: ReactNode;
    description?: ReactNode;
    containerClassName?: string;
    labelClassName?: string;
}

export function ProfileNumberField({
    label,
    description,
    containerClassName = "space-y-2",
    labelClassName,
    id,
    ...inputProps
}: ProfileNumberFieldProps) {
    return (
        <div className={containerClassName}>
            <Label htmlFor={id} className={labelClassName}>
                {label}
            </Label>
            {description !== undefined && <FieldHint>{description}</FieldHint>}
            <ProfileNumberInput id={id} {...inputProps} />
        </div>
    );
}
