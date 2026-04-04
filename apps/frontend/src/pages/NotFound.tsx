import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import logger from "@/lib/logger";
import { useLanguage } from "@/contexts/LanguageContext";
import { FileQuestion, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

const NotFound = () => {
    const location = useLocation();
    const { t } = useLanguage();

    useEffect(() => {
        logger.warn("404 Error: User attempted to access non-existent route:", location.pathname);
    }, [location.pathname]);

    return (
        <div className="flex min-h-[70vh] items-center justify-center">
            <div className="text-center space-y-6 max-w-md mx-auto px-4">
                <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary mx-auto shadow-sm">
                    <FileQuestion className="h-10 w-10" />
                </div>
                <div className="space-y-2">
                    <h1 className="text-6xl font-bold text-foreground tracking-tight">{t('notFound.title')}</h1>
                    <p className="text-xl text-muted-foreground">{t('notFound.heading')}</p>
                </div>
                <p className="text-muted-foreground/80">{t('notFound.description')}</p>
                <Button asChild size="lg" className="gap-2">
                    <Link to="/">
                        <ArrowLeft className="h-4 w-4" />
                        {t('notFound.backHome')}
                    </Link>
                </Button>
            </div>
        </div>
    );
};

export default NotFound;
