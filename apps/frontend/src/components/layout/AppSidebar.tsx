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
  Tags,
  Target,
  TrendingUp,
  Users,
  Wallet,
  ArrowLeftRight,
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
      ],
    },
    {
      label: t('nav.data'),
      items: [
        { title: t('nav.importExport'), url: "/import", icon: Import },
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
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 rounded-xl bg-gradient-to-br from-primary via-primary/90 to-accent/60 flex items-center justify-center shadow-lg shadow-primary/25 transition-transform duration-300 hover:scale-105">
            <Wallet className="h-5 w-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="text-base font-bold text-sidebar-foreground tracking-tight truncate">
                Vision
              </h1>
              <p className="text-[11px] text-muted-foreground truncate">{t('nav.financeManager')}</p>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Workspace switcher */}
        {!collapsed && (
          <div className="px-3 pt-3">
            <div className="flex rounded-lg bg-muted p-1 gap-1">
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
          <div className="flex flex-col items-center gap-1 pt-3 px-1">
            <button
              onClick={() => setWorkspace("budgeting")}
              className={`p-2 rounded-md transition-colors ${workspace === "budgeting" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title={t('nav.budgeting')}
            >
              <Receipt className="h-4 w-4" />
            </button>
            <button
              onClick={() => setWorkspace("portfolio")}
              className={`p-2 rounded-md transition-colors ${workspace === "portfolio" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title={t('nav.portfolio')}
            >
              <Briefcase className="h-4 w-4" />
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
                        <NavLink to={item.url} onMouseEnter={() => handleNavHover(item.url)}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
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

      <SidebarFooter className="border-t border-sidebar-border p-3">
        {!collapsed && (
          <p className="text-[11px] text-muted-foreground/60 text-center font-medium tracking-wide uppercase">
            Vision v1.0
          </p>
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
      className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-200 ${active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
          : "text-muted-foreground hover:text-foreground hover:bg-background/50"
        }`}
    >
      {icon}
      {label}
    </button>
  );
}
