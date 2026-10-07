import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { PanelLeftClose, Search, Settings } from "lucide-react";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
    useSidebar,
} from "@/components/ui/sidebar";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { usePortfolioPrefetch } from "@/hooks/usePortfolioPrefetch";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useHiddenSections } from "@/hooks/useSidebarPreferences";
import { useUpdateStatus } from "@/hooks/useUpdateStatus";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { preloadRoute } from "@/lib/routePreload";
import {
    ADMIN_SECTION,
    FOOTER_NAV_ITEMS,
    GO_TO_KEY_BY_URL,
    NAV_SECTIONS,
    isActiveNavItem,
    matchNavSectionId,
    type NavItem,
    type NavSection,
} from "@/lib/navigation";
import { NavItemBadge } from "@/components/layout/NavItemBadge";
import { VisionMark } from "@/components/shared/VisionMark";
import { APP_NAME } from "@/lib/appIdentity";

interface AppSidebarProps {
    onOpenSettings: () => void;
    onOpenPalette: () => void;
}

// Collapsed-rail tooltips double as shortcut teachers: "Transactions · G T".
function withGoToHint(title: string, url: string): string {
    const key = GO_TO_KEY_BY_URL.get(url);
    return key ? `${title} · G ${key.toUpperCase()}` : title;
}

/**
 * One labelled sidebar (ADR-180): the top items, then the Money, Wealth and
 * Research sections, each of which the user can hide, then Admin when admin
 * mode is on, and a footer with the assistant and Settings. Everything is
 * visible at once; the icon rail is a remembered choice, not the default.
 */
export function AppSidebar({ onOpenSettings, onOpenPalette }: AppSidebarProps) {
    const { state, toggleSidebar, isMobile } = useSidebar();
    const collapsed = state === "collapsed" && !isMobile;
    const location = useLocation();
    const { t } = useLanguage();
    const { prefetchNetWorth, prefetchPerformance } = usePortfolioPrefetch();
    const { appSettings } = useAppSettings();
    const { data: updateStatus } = useUpdateStatus();
    const updateReady = updateStatus !== undefined && !updateStatus.up_to_date;

    const handleNavHover = useCallback(
        (url: string) => {
            preloadRoute(url);
            if (url === "/portfolio/net-worth") prefetchNetWorth();
            else if (url === "/portfolio") prefetchPerformance();
        },
        [prefetchNetWorth, prefetchPerformance],
    );

    const sections = useMemo(
        () =>
            appSettings.adminMode
                ? [...NAV_SECTIONS, ADMIN_SECTION]
                : NAV_SECTIONS,
        [appSettings.adminMode],
    );
    const activeSectionId = matchNavSectionId(location.pathname);

    return (
        <Sidebar
            collapsible="icon"
            className="app-sidebar glass-chrome border-r border-sidebar-border/60"
        >
            <SidebarHeader
                className={cn("gap-2 pb-2 pt-3", collapsed ? "px-2" : "px-3")}
            >
                <div
                    className={cn(
                        "flex h-8 items-center gap-2.5",
                        collapsed && "justify-center",
                    )}
                >
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleSidebar()}
                        aria-label={t("aria.toggleSidebar")}
                        aria-expanded={!collapsed}
                        className="h-7 w-7 shrink-0 rounded-chip bg-gradient-to-br from-primary via-primary/85 to-accent/70 text-primary-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.6)] hover:bg-transparent hover:text-primary-foreground hover:brightness-110 [&_svg]:size-3.5"
                    >
                        <VisionMark className="h-3.5 w-3.5" />
                    </Button>
                    {!collapsed && (
                        <>
                            <span className="min-w-0 flex-1 truncate font-display type-headline text-sidebar-foreground">
                                {APP_NAME}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => toggleSidebar()}
                                aria-label={t("aria.collapseSidebar")}
                                className="h-7 w-7 shrink-0 rounded-chip text-label-tertiary hover:text-foreground"
                            >
                                <PanelLeftClose aria-hidden="true" />
                            </Button>
                        </>
                    )}
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    onClick={onOpenPalette}
                    aria-label={t("commandPalette.openLabel")}
                    aria-keyshortcuts="Meta+K Control+K"
                    className={cn(
                        "h-8 justify-start gap-2 rounded-chip bg-foreground/[0.06] px-0 type-callout font-normal text-label-tertiary hover:bg-foreground/[0.09] hover:text-label-secondary",
                        collapsed ? "w-8 justify-center" : "w-full px-2.5",
                    )}
                >
                    <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!collapsed && (
                        <>
                            <span className="min-w-0 flex-1 truncate text-left">
                                {t("commandPalette.hint")}
                            </span>
                            <kbd
                                aria-hidden="true"
                                className="type-caption text-label-tertiary"
                            >
                                ⌘K
                            </kbd>
                        </>
                    )}
                </Button>
            </SidebarHeader>

            <SidebarContent className="gap-0">
                <nav
                    aria-label={t("nav.primary")}
                    className="flex w-full flex-col"
                >
                    {sections.map((section, index) => (
                        <NavSectionGroup
                            key={section.id}
                            section={section}
                            collapsed={collapsed}
                            containsActive={activeSectionId === section.id}
                            pathname={location.pathname}
                            onHover={handleNavHover}
                            separator={collapsed && index > 0}
                        />
                    ))}
                </nav>
            </SidebarContent>

            <SidebarFooter className="border-t border-sidebar-border/50 px-2.5 py-2 group-data-[collapsible=icon]:px-2">
                <SidebarMenu>
                    {FOOTER_NAV_ITEMS.map((item) => (
                        <NavMenuItem
                            key={item.url}
                            item={item}
                            collapsed={collapsed}
                            pathname={location.pathname}
                            onHover={handleNavHover}
                        />
                    ))}
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            onClick={onOpenSettings}
                            tooltip={`${t("layout.settings")} · ⌘,`}
                            title={`${t("layout.settings")} (⌘,)`}
                            className="relative"
                        >
                            <Settings aria-hidden="true" />
                            <span className="truncate group-data-[collapsible=icon]:hidden">
                                {t("layout.settings")}
                            </span>
                            {updateReady && (
                                <>
                                    <span
                                        aria-hidden="true"
                                        data-testid="update-ready-dot"
                                        className={cn(
                                            "h-[7px] w-[7px] shrink-0 rounded-full bg-primary",
                                            collapsed
                                                ? "absolute right-1 top-1"
                                                : "ml-auto",
                                        )}
                                    />
                                    <span className="sr-only">
                                        {t("layout.updateReady")}
                                    </span>
                                </>
                            )}
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    );
}

interface NavSectionGroupProps {
    section: NavSection;
    collapsed: boolean;
    /** The active page is inside this section, so it must be visible. */
    containsActive: boolean;
    pathname: string;
    onHover: (url: string) => void;
    separator: boolean;
}

function NavSectionGroup({
    section,
    collapsed,
    containsActive,
    pathname,
    onHover,
    separator,
}: NavSectionGroupProps) {
    const { t } = useLanguage();
    const { isHidden, setSectionHidden } = useHiddenSections();
    const contentId = useId();
    const hidden = section.collapsible && isHidden(section.id);
    const open = !hidden || containsActive;

    // Landing inside a hidden section (deep link, palette, shortcut) shows
    // it for good: the user is clearly using it now.
    useEffect(() => {
        if (hidden && containsActive) setSectionHidden(section.id, false);
    }, [hidden, containsActive, section.id, setSectionHidden]);

    const label = section.labelKey ? t(section.labelKey) : undefined;
    const toggleLabel = open ? t("nav.hideSection") : t("nav.showSection");

    return (
        <SidebarGroup className="group/section">
            {separator && <SidebarSeparator className="mx-1 mb-1" />}
            {label && (
                <SidebarGroupLabel className="justify-between pr-1">
                    <span className="truncate">{label}</span>
                    {section.collapsible && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setSectionHidden(section.id, open)}
                            aria-expanded={open}
                            aria-controls={contentId}
                            aria-label={`${toggleLabel} ${label}`}
                            className="h-auto rounded-chip px-1 py-0 type-caption font-medium text-label-tertiary opacity-0 transition-opacity duration-fast hover:bg-transparent hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 aria-[expanded=false]:opacity-100"
                        >
                            {toggleLabel}
                        </Button>
                    )}
                </SidebarGroupLabel>
            )}
            <div
                id={contentId}
                aria-hidden={!open}
                className={cn(
                    "grid transition-[grid-template-rows] duration-normal ease-glide motion-reduce:transition-none",
                    open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
            >
                <SidebarGroupContent
                    className="min-h-0 overflow-hidden"
                    inert={!open}
                >
                    <SidebarMenu>
                        {section.items.map((item) => (
                            <NavMenuItem
                                key={item.url}
                                item={item}
                                collapsed={collapsed}
                                pathname={pathname}
                                onHover={onHover}
                            />
                        ))}
                    </SidebarMenu>
                </SidebarGroupContent>
            </div>
        </SidebarGroup>
    );
}

interface NavMenuItemProps {
    item: NavItem;
    collapsed: boolean;
    pathname: string;
    onHover: (url: string) => void;
}

function NavMenuItem({ item, collapsed, pathname, onHover }: NavMenuItemProps) {
    const { t } = useLanguage();
    const title = t(item.titleKey);
    const isActive = isActiveNavItem(item, pathname);
    const goToKey = GO_TO_KEY_BY_URL.get(item.url);
    const linkRef = useRef<HTMLAnchorElement>(null);

    // A long sidebar scrolls; the page the user is on must be in view.
    useEffect(() => {
        if (isActive) linkRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [isActive]);

    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                asChild
                isActive={isActive}
                tooltip={withGoToHint(title, item.url)}
            >
                <NavLink
                    ref={linkRef}
                    to={item.url}
                    onMouseEnter={() => onHover(item.url)}
                    onFocus={() => onHover(item.url)}
                    className="relative"
                    aria-current={isActive ? "page" : undefined}
                >
                    <item.icon aria-hidden="true" />
                    <span className="truncate group-data-[collapsible=icon]:hidden">
                        {title}
                    </span>
                    {collapsed ? (
                        item.badge && <NavItemBadge kind={item.badge} collapsed />
                    ) : (
                        (item.badge || goToKey) && (
                            <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                {item.badge && <NavItemBadge kind={item.badge} />}
                                {goToKey && (
                                    <kbd
                                        aria-hidden="true"
                                        className="hidden type-caption text-label-tertiary opacity-0 transition-opacity duration-fast group-hover/menu-button:opacity-100 group-focus-visible/menu-button:opacity-100 md:inline"
                                    >
                                        G {goToKey.toUpperCase()}
                                    </kbd>
                                )}
                            </span>
                        )
                    )}
                </NavLink>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}
