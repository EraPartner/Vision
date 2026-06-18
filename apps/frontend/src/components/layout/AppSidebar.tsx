import { useCallback, useMemo } from "react";
import { NavLink, useLocation } from "react-router-dom";
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
import {
  BarChart3,
  Briefcase,
  Landmark,
  Building2,
  CalendarClock,
  Gem,
  Coins,
  HandCoins,
  Import,
  LayoutDashboard,
  LineChart,
  PiggyBank,
  Receipt,
  Sparkles,
  Tags,
  Target,
  TrendingUp,
  Users,
  Wallet,
  ArrowLeftRight,
  Database,
  ShieldCheck,
  Activity,
  Globe,
  PanelLeftClose,
  Telescope,
  GitCompareArrows,
  CandlestickChart,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePortfolioPrefetch } from "@/hooks/usePortfolioPrefetch";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { springs } from "@/lib/motion";
import { preloadRoute } from "@/lib/routePreload";
import { GO_TO_ROUTES } from "@/hooks/useGoToShortcuts";

/**
 * The active-route accent rail as a shared layout element: framer-motion
 * glides it between nav items on navigation instead of blinking it on/off.
 */
function ActiveRail() {
  const reducedMotion = useReducedMotion();
  return (
    <motion.span
      layoutId="sidebar-active-rail"
      aria-hidden="true"
      className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-[2px] bg-gradient-to-b from-primary to-accent shadow-[0_0_14px_hsl(var(--primary)/0.6)]"
      transition={reducedMotion ? { duration: 0 } : springs.snappy}
    />
  );
}

// Collapsed-rail tooltips double as shortcut teachers: "Transactions · G T".
const GO_TO_BY_URL = new Map(GO_TO_ROUTES.map((r) => [r.url, r.key]));

function withGoToHint(title: string, url: string): string {
  const key = GO_TO_BY_URL.get(url);
  return key ? `${title} · G ${key.toUpperCase()}` : title;
}

function isActiveRoute(itemUrl: string, pathname: string) {
  // Workspace roots are active only on an exact match (they have children).
  if (itemUrl === "/" || itemUrl === "/portfolio" || itemUrl === "/research") return pathname === itemUrl;
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

  const budgetingGroups = useMemo(() => [
    {
      label: t('nav.overview'),
      items: [
        { title: t('nav.dashboard'), url: "/", icon: LayoutDashboard },
        { title: t('nav.transactions'), url: "/transactions", icon: Receipt },
      ],
    },
    {
      label: t('nav.organization'),
      items: [
        { title: t('nav.categories'), url: "/categories", icon: Tags },
        { title: t('nav.recipients'), url: "/recipients", icon: Users },
      ],
    },
    {
      label: t('nav.analysis'),
      items: [
        { title: t('nav.statistics'), url: "/statistics", icon: BarChart3 },
        { title: t('nav.plannedPayments'), url: "/planned", icon: CalendarClock },
        { title: t('nav.whoOwesYou'), url: "/owes", icon: HandCoins },
        { title: t('nav.taxOverview'), url: "/tax", icon: Landmark },
      ],
    },
    {
      label: t('nav.tools'),
      items: [
        { title: t('nav.importExport'), url: "/import", icon: Import },
      ],
    },
  ], [t]);

  const adminItems = useMemo(() => [
    { title: t('nav.adminOverview'), url: "/admin", icon: ShieldCheck },
    { title: t('nav.dbMaintenance'), url: "/admin/db", icon: Database },
    { title: t('nav.adminProviders'), url: "/admin/providers", icon: Globe },
    { title: t('nav.adminEndpoints'), url: "/admin/endpoints", icon: Activity },
    { title: t('nav.exchangeRates'), url: "/admin/exchange-rates", icon: ArrowLeftRight },
  ], [t]);

  const portfolioGroups = useMemo(() => [
    {
      label: t('nav.overview'),
      items: [
        { title: t('nav.dashboard'), url: "/portfolio", icon: LayoutDashboard },
        { title: t('nav.netWorth'), url: "/portfolio/net-worth", icon: Wallet },
      ],
    },
    {
      label: t('nav.investments'),
      items: [
        { title: t('nav.stocksEtfs'), url: "/portfolio/stocks", icon: TrendingUp },
        { title: t('nav.crypto'), url: "/portfolio/crypto", icon: Coins },
        { title: t('nav.metals'), url: "/portfolio/metals", icon: Gem },
      ],
    },
    {
      label: t('nav.assets'),
      items: [
        { title: t('nav.realEstate'), url: "/portfolio/real-estate", icon: Building2 },
        { title: t('nav.savingsBonds'), url: "/portfolio/savings", icon: PiggyBank },
      ],
    },
    {
      label: t('nav.analysis'),
      items: [
        { title: t('nav.performance'), url: "/portfolio/performance", icon: BarChart3 },
        { title: t('nav.taxOverview'), url: "/portfolio/tax", icon: Landmark },
      ],
    },
    {
      label: t('nav.tools'),
      items: [
        { title: t('nav.portfolioImport'), url: "/portfolio/import", icon: Import },
      ],
    },
  ], [t]);

  const researchGroups = useMemo(() => [
    {
      label: t('nav.overview'),
      items: [
        { title: t('nav.researchHome'), url: "/research", icon: Telescope },
        { title: t('nav.markets'), url: "/research/markets", icon: Globe },
        { title: t('nav.marketLookup'), url: "/research/market", icon: LineChart },
      ],
    },
    {
      label: t('nav.analysis'),
      items: [
        { title: t('nav.compare'), url: "/research/compare", icon: GitCompareArrows },
        { title: t('nav.chartBuilder'), url: "/research/charts", icon: CandlestickChart },
        { title: t('nav.forecast'), url: "/research/forecast", icon: TrendingUp },
        { title: t('nav.watchlist'), url: "/research/watchlist", icon: Target },
      ],
    },
  ], [t]);

  const groups =
    workspace === "budgeting" ? budgetingGroups
      : workspace === "research" ? researchGroups
        : portfolioGroups;

  return (
    <Sidebar collapsible="icon" className="glass-chrome border-r border-sidebar-border/60">
      <SidebarHeader className={`border-b border-sidebar-border/50 py-4 ${collapsed ? "px-0" : "px-4"}`}>
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <button
            type="button"
            onClick={() => toggleSidebar()}
            aria-label={t('aria.toggleSidebar')}
            className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-primary via-primary/85 to-accent/70 flex items-center justify-center shadow-[0_10px_30px_-10px_hsl(var(--primary)/0.55)] ring-1 ring-primary/20 transition-transform duration-300 hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Wallet className="h-4 w-4 text-primary-foreground" />
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
        {/* AI Chat — workspace-agnostic, shown above workspace switcher */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActiveRoute("/ai-chat", location.pathname)}
                  tooltip={withGoToHint(t('nav.aiChat'), "/ai-chat")}
                >
                  <NavLink
                    to="/ai-chat"
                    onMouseEnter={() => handleNavHover("/ai-chat")}
                    className="relative"
                    aria-label={t('nav.aiChat')}
                  >
                    {isActiveRoute("/ai-chat", location.pathname) && <ActiveRail />}
                    <Sparkles className={`h-4 w-4 transition-colors duration-[var(--duration-normal)] ${isActiveRoute("/ai-chat", location.pathname) ? "text-primary" : ""}`} />
                    <span className={isActiveRoute("/ai-chat", location.pathname) ? "font-semibold tracking-tight" : "tracking-tight"}>
                      {t('nav.aiChat')}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {/* Accounts — workspace-agnostic hub (ADR-088) */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActiveRoute("/accounts", location.pathname)}
                  tooltip={withGoToHint(t('nav.accounts'), "/accounts")}
                >
                  <NavLink
                    to="/accounts"
                    onMouseEnter={() => handleNavHover("/accounts")}
                    className="relative"
                    aria-label={t('nav.accounts')}
                  >
                    {isActiveRoute("/accounts", location.pathname) && <ActiveRail />}
                    <Landmark className={`h-4 w-4 transition-colors duration-[var(--duration-normal)] ${isActiveRoute("/accounts", location.pathname) ? "text-primary" : ""}`} />
                    <span className={isActiveRoute("/accounts", location.pathname) ? "font-semibold tracking-tight" : "tracking-tight"}>
                      {t('nav.accounts')}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Workspace switcher */}
        {!collapsed && (
          <div className="px-3 pt-3">
            <div className="flex rounded-xl bg-sidebar-accent/60 ring-1 ring-sidebar-border/50 p-1 gap-1 backdrop-blur-sm">
              <WorkspaceTab
                active={workspace === "budgeting"}
                onClick={() => setWorkspace("budgeting")}
                icon={<Receipt className="h-3.5 w-3.5" />}
                label={t('nav.budgeting')}
              />
              <WorkspaceTab
                active={workspace === "portfolio"}
                onClick={() => setWorkspace("portfolio")}
                icon={<Briefcase className="h-3.5 w-3.5" />}
                label={t('nav.portfolio')}
              />
              <WorkspaceTab
                active={workspace === "research"}
                onClick={() => setWorkspace("research")}
                icon={<Telescope className="h-3.5 w-3.5" />}
                label={t('nav.research')}
              />
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center pt-3 px-1.5">
            <button
              onClick={() => setWorkspace(
                workspace === "budgeting" ? "portfolio"
                  : workspace === "portfolio" ? "research"
                    : "budgeting",
              )}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              title={workspace === "budgeting" ? t('nav.budgeting') : workspace === "portfolio" ? t('nav.portfolio') : t('nav.research')}
            >
              {workspace === "budgeting" ? <Receipt className="h-4 w-4" /> : workspace === "portfolio" ? <Briefcase className="h-4 w-4" /> : <Telescope className="h-4 w-4" />}
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
                          <item.icon className={`h-4 w-4 transition-colors duration-[var(--duration-normal)] ${isActive ? "text-primary" : ""}`} />
                          <span className={isActive ? "font-semibold tracking-tight" : "tracking-tight"}>{item.title}</span>
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
                          <item.icon className={`h-4 w-4 transition-colors duration-[var(--duration-normal)] ${isActive ? "text-primary" : ""}`} />
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
      className={`min-w-0 flex-1 flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-xs font-medium tracking-tight transition-all duration-[var(--duration-normal)] ease-[var(--ease-out-expo)] ${active
          ? "bg-background/90 text-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.35)] ring-1 ring-primary/25 scale-[1.02]"
          : "text-muted-foreground hover:text-foreground hover:bg-background/40"
        }`}
    >
      <span className={`shrink-0 transition-colors duration-200 ${active ? "text-primary" : ""}`}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
