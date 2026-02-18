import { useState } from 'react';
import {SidebarProvider, SidebarTrigger} from "@/components/ui/sidebar";
import {AppSidebar} from "@/components/layout/AppSidebar";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { DashboardSettingsDialog } from "@/components/settings/DashboardSettingsDialog";

interface AppLayoutProps {
    children: React.ReactNode;
}

export function AppLayout({children}: AppLayoutProps) {
    const [settingsOpen, setSettingsOpen] = useState(false);

    return (
        <SidebarProvider>
            <div className="min-h-screen flex w-full">
                <AppSidebar/>
                <div className="flex-1 flex flex-col min-w-0">
                    <header
                        className="h-14 border-b bg-card/80 backdrop-blur-sm flex items-center px-4 sticky top-0 z-30">
                        <SidebarTrigger className="mr-4"/>
                        <div className="flex-1" />
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSettingsOpen(true)}
                            className="ml-auto"
                            title="Dashboard Settings"
                        >
                            <Settings className="h-5 w-5" />
                        </Button>
                    </header>
                    <main className="flex-1 p-6">
                        {children}
                    </main>
                </div>
            </div>
            <DashboardSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </SidebarProvider>
    );
}
