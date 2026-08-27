import { Lock, Snowflake } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

interface TaxYearStatusIconProps {
    isFiled?: boolean;
    hasFrozenCalculation?: boolean;
    className?: string;
}

/** Compact filed/frozen marker for tax-year lists and comparison surfaces. */
export function TaxYearStatusIcon({
    isFiled = false,
    hasFrozenCalculation = false,
    className,
}: TaxYearStatusIconProps) {
    const { t } = useLanguage();

    if (isFiled) {
        return (
            <Lock
                className={cn('text-warning', className)}
                aria-label={t('tax.yearSwitcher.filedAria')}
            />
        );
    }

    if (hasFrozenCalculation) {
        return (
            <Snowflake
                className={cn('text-sky-600', className)}
                aria-label={t('tax.yearSwitcher.frozenAria')}
            />
        );
    }

    return null;
}
