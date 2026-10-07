import {
    useContext,
    useId,
    type MouseEventHandler,
    type ReactNode,
} from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SymbolSearchListContext } from "@/components/shared/symbolSearchContext";
import { Link } from "react-router";

/** Shape shared by the research (`searchResearch`) and market (`searchMarket`) search results. */
export interface SymbolSearchResult {
    symbol: string;
    name: string;
    type: string;
    exchange: string;
}

interface SymbolSearchResultItemProps {
    item: SymbolSearchResult;
    onSelect?: (item: SymbolSearchResult) => void;
    /** Real destination for navigation-style results. */
    to?: string;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    /** Optional leading affordance (e.g. a Plus icon) for add-to-list pickers. */
    leadingIcon?: ReactNode;
    className?: string;
}

/**
 * Canonical company/ticker search-result row, shared across every symbol picker
 * (Research home, Market Lookup, Compare, Chart Builder, Add-to-Watchlist) so
 * they stay visually consistent: mono ticker, company name, asset-type badge,
 * and exchange. Add-style pickers pass a `leadingIcon` (a Plus); navigate-style
 * pickers omit it.
 */
export function SymbolSearchResultItem({
    item,
    onSelect,
    to,
    onClick,
    leadingIcon,
    className,
}: SymbolSearchResultItemProps) {
    const searchList = useContext(SymbolSearchListContext);
    const insideSearchList = searchList !== null;
    const optionId = `symbol-search-option-${useId()}`;
    const active = searchList?.activeOptionId === optionId;

    const content = (
        <>
            {leadingIcon}
            <span className="min-w-[5rem] font-mono type-body font-medium text-foreground">
                {item.symbol}
            </span>
            <span className="flex-1 truncate type-body text-label-secondary">
                {item.name}
            </span>
            {item.type ? (
                <Badge variant="outline" size="sm" className="shrink-0">
                    {item.type}
                </Badge>
            ) : null}
            {item.exchange ? (
                <span className="shrink-0 type-footnote text-label-secondary">
                    {item.exchange}
                </span>
            ) : null}
        </>
    );
    const classes = cn(
        "flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.06] focus-ring",
        active && "bg-foreground/[0.06]",
        className,
    );
    const optionProps = {
        id: insideSearchList ? optionId : undefined,
        role: insideSearchList ? "option" : undefined,
        "aria-selected": insideSearchList ? active : undefined,
        tabIndex: insideSearchList ? -1 : undefined,
        onPointerMove: () => searchList?.setActiveOptionId(optionId),
        className: classes,
    };

    return to ? (
        <Link to={to} onClick={onClick} {...optionProps}>
            {content}
        </Link>
    ) : (
        <button type="button" onClick={() => onSelect?.(item)} {...optionProps}>
            {content}
        </button>
    );
}
