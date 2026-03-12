import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import logger from "@/lib/logger";
import { useLanguage } from "@/contexts/LanguageContext";

const NotFound = () => {
    const location = useLocation();
    const { t } = useLanguage();

    useEffect(() => {
        logger.warn("404 Error: User attempted to access non-existent route:", location.pathname);
    }, [location.pathname]);

    return (
        <div className="flex min-h-screen items-center justify-center bg-gray-100">
            <div className="text-center">
                <h1 className="mb-4 text-4xl font-bold">{t('notFound.title')}</h1>
                <p className="mb-4 text-xl text-gray-600">{t('notFound.heading')}</p>
                <p className="mb-4 text-gray-500">{t('notFound.description')}</p>
                <a href="/" className="text-blue-500 underline hover:text-blue-700">
                    {t('notFound.backHome')}
                </a>
            </div>
        </div>
    );
};

export default NotFound;
