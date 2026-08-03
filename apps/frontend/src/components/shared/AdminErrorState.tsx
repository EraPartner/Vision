import { Link } from 'react-router';
import { KeyRound } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { ApiClientError } from '@/lib/api/client';

/**
 * True when a query error is an admin auth failure (401 Unauthorized / 403
 * Forbidden). These are recoverable by setting the admin token on `/admin`,
 * so the error state points the user there rather than showing a raw string.
 */
function isAdminAuthError(error: unknown): boolean {
    return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

/**
 * Error state for admin sub-pages. On an auth failure it mirrors the token card
 * on `/admin` and links back to it; any other error falls back to a plain
 * message so the user still sees what went wrong.
 */
export function AdminErrorState({ error, fallbackMessage }: { error: unknown; fallbackMessage: string }) {
    const { t } = useLanguage();

    if (isAdminAuthError(error)) {
        return (
            <Card className="!border-destructive/60 bg-destructive/5">
                <CardContent className="space-y-3 pt-6">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5">
                            <KeyRound className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <p className="text-sm font-semibold">{t('admin.authError.title')}</p>
                            <p className="text-xs text-muted-foreground">{t('admin.authError.description')}</p>
                        </div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/admin">{t('admin.authError.action')}</Link>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    const message = error instanceof Error ? error.message : String(error);
    return (
        <Card className="!border-destructive/60 bg-destructive/5">
            <CardContent className="pt-6">
                <p className="text-sm text-destructive">{fallbackMessage}: {message}</p>
            </CardContent>
        </Card>
    );
}
