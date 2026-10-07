import { Link, useLocation } from "react-router";
import { useEffect } from "react";
import logger from "@/lib/logger";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextLink } from "@/components/shared/TextLink";
import { VisionMark } from "@/components/shared/VisionMark";

const NotFound = () => {
    const location = useLocation();
    const { t } = useLanguage();

    useEffect(() => {
        logger.warn("404 Error: User attempted to access non-existent route:", location.pathname);
    }, [location.pathname]);

    return (
        <div className="flex min-h-[70vh] items-center justify-center">
            <div className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 text-center">
                <div
                    aria-hidden="true"
                    className="inline-flex h-20 w-20 items-center justify-center rounded-card corner-continuous bg-primary/12 text-primary"
                >
                    <VisionMark className="h-10 w-10" />
                </div>
                <div className="space-y-2">
                    <h1 className="font-display type-large-title tabular-nums text-foreground">
                        {t('notFound.title')}
                    </h1>
                    <p className="type-title-3 text-label-secondary">{t('notFound.heading')}</p>
                </div>
                <p className="type-body text-label-secondary">{t('notFound.description')}</p>
                <Button asChild>
                    <Link to="/">
                        <ArrowLeft aria-hidden="true" />
                        {t('notFound.backHome')}
                    </Link>
                </Button>
                <div className="flex items-center justify-center gap-3 type-callout text-label-secondary">
                    <TextLink tone="muted" to="/transactions">
                        {t('nav.transactions')}
                    </TextLink>
                    <span aria-hidden="true">·</span>
                    <TextLink tone="muted" to="/import">
                        {t('nav.importExport')}
                    </TextLink>
                </div>
            </div>
        </div>
    );
};

export default NotFound;
