import {type ClassValue, cx} from "@/lib/classNames";
import {twMerge} from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(cx(inputs));
}
