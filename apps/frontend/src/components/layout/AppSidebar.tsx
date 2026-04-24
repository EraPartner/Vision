import { useCallback } from "react";
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
  GitMerge,
} from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePortfolioPrefetch } from "@/hooks/usePortfolioPrefetch";

function isActiveRoute(itemUrl: string, pathname: string) {
  if (itemUrl === "/" && pathname === "/") return true;
  if (itemUrl === "/portfolio" && pathname === "/portfolio") return true;
  if (itemUrl !== "/" && itemUrl !== "/portfolio") return pathname.startsWith(itemUrl);
  return false;
}

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { workspace, setWorkspace } = useWorkspace();
  const { t } = useLanguage();
  const { prefetchNetWorth, prefetchPerformance } = usePortfolioPrefetch(workspace);

  const handleNavHover = useCallback((url: string) => {
    if (url === "/portfolio/net-worth") prefetchNetWorth();
    else if (url === "/portfolio/performance") prefetchPerformance();
  }, [prefetchNetWorth, prefetchPerformance]);

  const budgetingGroups = [
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
        { title: t('nav.reconciliation'), url: "/reconciliation", icon: GitMerge },
      ],
    },
    {
      label: t('nav.data'),
      items: [
        { title: t('nav.importExport'), url: "/import", icon: Import },
        { title: t('nav.dbMaintenance'), url: "/admin/db", icon: Database },
      ],
    },
  ];

  const portfolioGroups = [
    {
      label: t('nav.overview'),
      items: [
        { title: t('nav.dashboard'), url: "/portfolio", icon: LayoutDashboard },
        { title: t('nav.netWorth'), url: "/portfolio/net-worth", icon: Wallet },
        { title: t('nav.performance'), url: "/portfolio/performance", icon: BarChart3 },
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
      label: t('nav.tools'),
      items: [
        { title: t('nav.marketLookup'), url: "/portfolio/market", icon: LineChart },
        { title: t('nav.watchlist'), url: "/portfolio/watchlist", icon: Target },
        { title: t('nav.exchangeRates'), url: "/portfolio/exchange-rates", icon: ArrowLeftRight },
        { title: t('nav.taxOverview'), url: "/portfolio/tax", icon: Landmark },
      ],
    },
  ];

  const groups = workspace === "budgeting" ? budgetingGroups : portfolioGroups;

  return (
    <Sidebar collapsible="icon" className="glass-chrome border-r border-sidebar-border/60">
      <SidebarHeader className={`border-b border-sidebar-border/50 py-4 ${collapsed ? "px-0" : "px-4"}`}>
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <div className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-primary via-primary/85 to-accent/70 flex items-center justify-center shadow-[0_10px_30px_-10px_hsl(var(--primary)/0.55)] ring-1 ring-primary/20 transition-transform duration-300 hover:scale-[1.04]">
            <Wallet className="h-4 w-4 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="font-display text-lg font-semibold text-sidebar-foreground tracking-tight truncate leading-none">
                Vision
              </h1>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground truncate">
                {t('nav.financeManager')}
              </p>
            </div>
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
                  tooltip={t('nav.aiChat')}
                >
                  <NavLink
                    to="/ai-chat"
                    className={isActiveRoute("/ai-chat", location.pathname) ? "accent-rail" : ""}
                  >
                    <Sparkles className={`h-4 w-4 transition-colors duration-[var(--duration-normal)] ${isActiveRoute("/ai-chat", location.pathname) ? "text-primary" : ""}`} />
                    <span className={isActiveRoute("/ai-chat", location.pathname) ? "font-semibold tracking-tight" : "tracking-tight"}>
                      {t('nav.aiChat')}
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
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center pt-3 px-1.5">
            <button
              onClick={() => setWorkspace(workspace === "budgeting" ? "portfolio" : "budgeting")}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              title={workspace === "budgeting" ? t('nav.budgeting') : t('nav.portfolio')}
            >
              {workspace === "budgeting" ? <Receipt className="h-4 w-4" /> : <Briefcase className="h-4 w-4" />}
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
                      <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                        <NavLink
                          to={item.url}
                          onMouseEnter={() => handleNavHover(item.url)}
                          className={isActive ? "accent-rail" : ""}
                        >
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
      className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium tracking-tight transition-all duration-[var(--duration-normal)] ease-[var(--ease-out-expo)] ${active
          ? "bg-background/90 text-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.35)] ring-1 ring-primary/25 scale-[1.02]"
          : "text-muted-foreground hover:text-foreground hover:bg-background/40"
        }`}
    >
      <span className={`transition-colors duration-200 ${active ? "text-primary" : ""}`}>{icon}</span>
      {label}
    </button>
  );
}
