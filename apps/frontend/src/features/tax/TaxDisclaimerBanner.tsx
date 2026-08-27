import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface TaxDisclaimerBannerProps {
    title: string;
    description: string;
}

/** Highlighted info banner shown at the top of both tax pages. */
export function TaxDisclaimerBanner({
    title,
    description,
}: TaxDisclaimerBannerProps) {
    return (
        <Card className="!border-primary/50 bg-primary/5">
            <CardContent variant="row" className="flex items-start gap-3">
                <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm font-medium text-foreground">
                        {title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                        {description}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
