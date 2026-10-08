import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface TaxDisclaimerBannerProps {
    title: string;
    description: string;
}

/** Info note shown at the top of both tax pages. */
export function TaxDisclaimerBanner({
    title,
    description,
}: TaxDisclaimerBannerProps) {
    return (
        <Alert>
            <Info className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="text-label-secondary">
                {description}
            </AlertDescription>
        </Alert>
    );
}
