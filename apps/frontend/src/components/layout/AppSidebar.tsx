import {NavLink, useLocation} from "react-router-dom";
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
import {CalendarClock, Import, LayoutDashboard, Receipt, Tags, Users, Wallet} from "lucide-react";

const navItems = [
    {title: "Dashboard", url: "/", icon: LayoutDashboard},
    {title: "Transactions", url: "/transactions", icon: Receipt},
    {title: "Categories", url: "/categories", icon: Tags},
    {title: "Recipients", url: "/recipients", icon: Users},
    {title: "Planned", url: "/planned", icon: CalendarClock},
];

export function AppSidebar() {
    const {state} = useSidebar();
    const collapsed = state === "collapsed";
    const location = useLocation();

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="border-b border-sidebar-border px-4 py-5">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 shrink-0 rounded-xl bg-primary flex items-center justify-center shadow-md">
                        <Wallet className="h-5 w-5 text-primary-foreground"/>
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
                <SidebarGroup>
                    <SidebarGroupLabel>Navigation</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {navItems.map((item) => {
                                const isActive =
                                    item.url === "/"
                                        ? location.pathname === "/"
                                        : location.pathname.startsWith(item.url);

                                return (
                                    <SidebarMenuItem key={item.title}>
                                        <SidebarMenuButton
                                            asChild
                                            isActive={isActive}
                                            tooltip={item.title}
                                        >
                                            <NavLink to={item.url}>
                                                <item.icon className="h-4 w-4"/>
                                                <span>{item.title}</span>
                                            </NavLink>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                );
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup>
                    <SidebarGroupLabel>Actions</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton asChild tooltip="Import & Export">
                                    <NavLink to="/import">
                                        <Import className="h-4 w-4"/>
                                        <span>Import / Export</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
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
