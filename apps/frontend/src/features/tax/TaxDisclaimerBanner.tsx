import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface TaxDisclaimerBannerProps {
    title: string;
    description: string;
    /** Extra notes listed under the description (e.g. household engine issues). */
    notes?: readonly string[];
}

/** Info note shown at the top of both tax pages. */
export function TaxDisclaimerBanner({
    title,
    description,
    notes,
}: TaxDisclaimerBannerProps) {
    return (
        <Alert>
            <Info className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="text-label-secondary">
                {description}
                {notes && notes.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                        {notes.map((note) => (
                            <li key={note}>{note}</li>
                        ))}
                    </ul>
                )}
            </AlertDescription>
        </Alert>
    );
}
