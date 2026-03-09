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
  Building2,
  CalendarClock,
  Coins,
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
import { useWorkspace, type Workspace } from "@/contexts/WorkspaceContext";

const budgetingGroups = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/", icon: LayoutDashboard },
      { title: "Transactions", url: "/transactions", icon: Receipt },
    ],
  },
  {
    label: "Organization",
    items: [
      { title: "Categories", url: "/categories", icon: Tags },
      { title: "Recipients", url: "/recipients", icon: Users },
    ],
  },
  {
    label: "Analysis",
    items: [
      { title: "Statistics", url: "/statistics", icon: BarChart3 },
      { title: "Planned Payments", url: "/planned", icon: CalendarClock },
    ],
  },
  {
    label: "Data",
    items: [
      { title: "Import / Export", url: "/import", icon: Import },
    ],
  },
];

const portfolioGroups = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/portfolio", icon: LayoutDashboard },
      { title: "Net Worth", url: "/portfolio/net-worth", icon: Wallet },
      { title: "Performance", url: "/portfolio/performance", icon: BarChart3 },
    ],
  },
  {
    label: "Investments",
    items: [
      { title: "Stocks & ETFs", url: "/portfolio/stocks", icon: TrendingUp },
      { title: "Crypto", url: "/portfolio/crypto", icon: Coins },
    ],
  },
  {
    label: "Assets",
    items: [
      { title: "Real Estate", url: "/portfolio/real-estate", icon: Building2 },
      { title: "Savings & Bonds", url: "/portfolio/savings", icon: PiggyBank },
    ],
  },
  {
    label: "Tools",
    items: [
      { title: "Market Lookup", url: "/portfolio/market", icon: LineChart },
      { title: "Watchlist", url: "/portfolio/watchlist", icon: Target },
      { title: "Exchange Rates", url: "/portfolio/exchange-rates", icon: ArrowLeftRight },
    ],
  },
];

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

  const groups = workspace === "budgeting" ? budgetingGroups : portfolioGroups;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-5">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 rounded-xl bg-primary flex items-center justify-center shadow-md">
            <Wallet className="h-5 w-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="text-base font-bold text-sidebar-foreground truncate">
                Vault Voyager
              </h1>
              <p className="text-xs text-muted-foreground truncate">Finance Manager</p>
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
                label="Budgeting"
              />
              <WorkspaceTab
                active={workspace === "portfolio"}
                onClick={() => setWorkspace("portfolio")}
                icon={<Briefcase className="h-3.5 w-3.5" />}
                label="Portfolio"
              />
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex flex-col items-center gap-1 pt-3 px-1">
            <button
              onClick={() => setWorkspace("budgeting")}
              className={`p-2 rounded-md transition-colors ${workspace === "budgeting" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title="Budgeting"
            >
              <Receipt className="h-4 w-4" />
            </button>
            <button
              onClick={() => setWorkspace("portfolio")}
              className={`p-2 rounded-md transition-colors ${workspace === "portfolio" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title="Portfolio"
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
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                        <NavLink to={item.url}>
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

      <SidebarFooter className="border-t border-sidebar-border p-4">
        {!collapsed && (
          <p className="text-xs text-muted-foreground text-center">
            Vault Voyager v1.0
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
      className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
