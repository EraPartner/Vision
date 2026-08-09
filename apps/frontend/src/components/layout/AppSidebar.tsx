import { useCallback, useMemo } from "react";
import { NavLink, useLocation } from "react-router";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { PanelLeftClose } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePortfolioPrefetch } from "@/hooks/usePortfolioPrefetch";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { cn } from "@/lib/utils";
import { springs } from "@/lib/motion";
import { preloadRoute } from "@/lib/routePreload";
import {
  ADMIN_NAV_ITEMS,
  GLOBAL_NAV_ITEMS,
  GO_TO_KEY_BY_URL,
  NAV_WORKSPACE_BY_ID,
  NAV_WORKSPACES,
  WORKSPACE_ROOT_URLS,
} from "@/lib/navigation";
import { InsightsNavBadge } from "@/components/layout/InsightsNavBadge";
import { VisionMark } from "@/components/shared/VisionMark";

/**
 * The active-route accent rail as a shared layout element: framer-motion
 * glides it between nav items on navigation instead of blinking it on/off.
 *
 * Sized as a flush full-height 2px bar (not a rounded inset pill) so it reads
 * as one continuous edge with the item's rounded-lg corner clip — no bulge.
 * This is the sole active indicator; the menu button's old inset box-shadow
 * was removed (ui/sidebar.tsx) to avoid doubling it.
 */
function ActiveRail() {
  const reducedMotion = useReducedMotion();
  return (
    <m.span
      layoutId="sidebar-active-rail"
      aria-hidden="true"
      className="absolute inset-y-0 left-0 w-[2px] bg-primary"
      transition={reducedMotion ? { duration: 0 } : springs.snappy}
    />
  );
}

// Collapsed-rail tooltips double as shortcut teachers: "Transactions · G T".
function withGoToHint(title: string, url: string): string {
  const key = GO_TO_KEY_BY_URL.get(url);
  return key ? `${title} · G ${key.toUpperCase()}` : title;
}

function isActiveRoute(itemUrl: string, pathname: string) {
  // Workspace roots are active only on an exact match (they have children).
  if (WORKSPACE_ROOT_URLS.has(itemUrl)) return pathname === itemUrl;
  // Boundary-aware prefix match so a route whose path is a string prefix of
  // another (e.g. /research/market vs /research/markets) doesn't light up its
  // sibling. Child routes (/import/:id) still highlight their parent nav item.
  return pathname === itemUrl || pathname.startsWith(itemUrl + "/");
}

export function AppSidebar() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { workspace, setWorkspace } = useWorkspace();
  const { t } = useLanguage();
  const { prefetchNetWorth, prefetchPerformance } = usePortfolioPrefetch(workspace);
  const { appSettings } = useAppSettings();

  const handleNavHover = useCallback((url: string) => {
    preloadRoute(url);
    if (url === "/portfolio/net-worth") prefetchNetWorth();
    else if (url === "/portfolio/performance") prefetchPerformance();
  }, [prefetchNetWorth, prefetchPerformance]);

  // The active workspace's nav, localized from the shared registry.
  const activeWorkspace = NAV_WORKSPACE_BY_ID[workspace];
  const groups = useMemo(() => activeWorkspace.groups.map((group) => ({
    label: t(group.labelKey),
    items: group.items.map((item) => ({ title: t(item.titleKey), url: item.url, icon: item.icon })),
  })), [activeWorkspace, t]);

  const adminItems = useMemo(() => ADMIN_NAV_ITEMS.map((item) => (
    { title: t(item.titleKey), url: item.url, icon: item.icon }
  )), [t]);

  return (
    <Sidebar collapsible="icon" className="glass-chrome border-r border-sidebar-border/60">
      <SidebarHeader className={cn("border-b border-sidebar-border/50 py-4", collapsed ? "px-0" : "px-4")}>
        <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
          <button
            type="button"
            onClick={() => toggleSidebar()}
            aria-label={t('aria.toggleSidebar')}
            className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-primary via-primary/85 to-accent/70 flex items-center justify-center shadow-[0_10px_30px_-10px_hsl(var(--primary)/0.55)] ring-1 ring-primary/20 transition-transform duration-300 hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <VisionMark className="h-4 w-4 text-primary-foreground" />
          </button>
          {!collapsed && (
            <>
              <div className="overflow-hidden flex-1">
                <h1 className="font-display text-lg font-semibold text-sidebar-foreground tracking-tight truncate leading-none">
                  Vision
                </h1>
                <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground truncate">
                  {t('nav.financeManager')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleSidebar()}
                aria-label={t('aria.collapseSidebar')}
                className="h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation landmark so SR users can jump straight to (or past) the
            sidebar. Replicates SidebarContent's column layout (flex-col gap-2)
            so wrapping everything in one flex child is visually free. */}
        <nav aria-label={t('nav.primary')} className="flex w-full flex-col gap-2">
        {/* Workspace-agnostic pages (AI chat, Accounts hub — ADR-088), shown
            above the workspace switcher */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {GLOBAL_NAV_ITEMS.map((item) => {
                const title = t(item.titleKey);
                const isActive = isActiveRoute(item.url, location.pathname);
                return (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={withGoToHint(title, item.url)}>
                      <NavLink
                        to={item.url}
                        onMouseEnter={() => handleNavHover(item.url)}
                        className="relative"
                        aria-label={title}
                      >
                        {isActive && <ActiveRail />}
                        <item.icon className={cn("h-4 w-4 transition-colors duration-[var(--duration-normal)]", isActive && "text-primary")} />
                        <span className={isActive ? "font-semibold tracking-tight" : "tracking-tight"}>
                          {title}
                        </span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Workspace switcher */}
        {!collapsed && (
          <div className="px-3 pt-3">
            <div className="flex rounded-xl bg-sidebar-accent/60 ring-1 ring-sidebar-border/50 p-1 gap-1">
              {NAV_WORKSPACES.map((ws) => (
                <WorkspaceTab
                  key={ws.id}
                  active={workspace === ws.id}
                  onClick={() => setWorkspace(ws.id)}
                  icon={<ws.icon className="h-3.5 w-3.5" />}
                  label={t(ws.labelKey)}
                />
              ))}
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center pt-3 px-1.5">
            {/* Cycles to the next workspace; shows the current one. */}
            <button
              onClick={() => {
                const idx = NAV_WORKSPACES.findIndex((ws) => ws.id === workspace);
                setWorkspace(NAV_WORKSPACES[(idx + 1) % NAV_WORKSPACES.length].id);
              }}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              title={t(activeWorkspace.labelKey)}
            >
              <activeWorkspace.icon className="h-4 w-4" />
            </button>
          </div>
        )}

        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = isActiveRoute(item.url, location.pathname);
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={withGoToHint(item.title, item.url)}>
                        <NavLink
                          to={item.url}
                          onMouseEnter={() => handleNavHover(item.url)}
                          className="relative"
                          aria-label={item.title}
                        >
                          {isActive && <ActiveRail />}
                          <item.icon className={cn("h-4 w-4 transition-colors duration-[var(--duration-normal)]", isActive && "text-primary")} />
                          <span className={isActive ? "font-semibold tracking-tight" : "tracking-tight"}>{item.title}</span>
                          {!collapsed && item.url === "/statistics" && <InsightsNavBadge />}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {appSettings.adminMode && (
          <SidebarGroup>
            <SidebarGroupLabel>{t('nav.admin')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminItems.map((item) => {
                  const isActive = item.url === "/admin"
                    ? location.pathname === "/admin"
                    : isActiveRoute(item.url, location.pathname);
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={withGoToHint(item.title, item.url)}>
                        <NavLink
                          to={item.url}
                          onMouseEnter={() => handleNavHover(item.url)}
                          className="relative"
                          aria-label={item.title}
                        >
                          {isActive && <ActiveRail />}
                          <item.icon className={cn("h-4 w-4 transition-colors duration-[var(--duration-normal)]", isActive && "text-primary")} />
                          <span className={isActive ? "font-semibold tracking-tight" : "tracking-tight"}>{item.title}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/50 p-3">
        {!collapsed && (
          <div className="flex items-center justify-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_hsl(var(--accent)/0.7)] motion-safe:animate-pulse" />
            <p className="text-[10px] text-muted-foreground/70 text-center font-medium tracking-[0.18em] uppercase">
              Vision v1.0
            </p>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

function WorkspaceTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        // Transition list composed via --press-compose (press-feedback owns the
        // `transition` shorthand — see index.css); press entry restated verbatim.
        "press-feedback [--press-compose:background-color_var(--duration-normal)_var(--ease-glide),color_var(--duration-normal)_var(--ease-glide),box-shadow_var(--duration-normal)_var(--ease-glide),transform_90ms_ease-out] min-w-0 flex-1 flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-xs font-medium tracking-tight",
        active
          ? "bg-background/90 text-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.35)] ring-1 ring-primary/25 scale-[1.02]"
          : "text-muted-foreground hover:text-foreground hover:bg-background/40",
      )}
    >
      <span className={cn("shrink-0 transition-colors duration-200", active && "text-primary")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
