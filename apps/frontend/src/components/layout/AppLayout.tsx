import { useState } from 'react';
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { Button } from "@/components/ui/button";
import { Settings, Sun, Moon, Monitor, Clock } from "lucide-react";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DashboardSettingsDialog } from "@/components/settings/DashboardSettingsDialog";
import { useTheme } from "@/contexts/ThemeContext";
import { UpcomingPaymentsNotification } from "@/components/notifications/UpcomingPaymentsNotification";
import { UpdateNotification } from "@/components/notifications/UpdateNotification";
import { OnboardingWizard, useOnboarding } from "@/components/onboarding/OnboardingWizard";

interface AppLayoutProps {
    children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const { theme, mode, schedule, setMode, setSchedule, toggleTheme } = useTheme();
    const { isComplete: onboardingComplete, isLoading: onboardingLoading, complete: completeOnboarding } = useOnboarding();

    const modeIcon = {
        light: <Sun className="h-5 w-5" />,
        dark: <Moon className="h-5 w-5" />,
        system: <Monitor className="h-5 w-5" />,
        schedule: <Clock className="h-5 w-5" />,
    }[mode];

    return (
        <SidebarProvider>
            <div className="min-h-screen flex w-full">
                <AppSidebar />
                <div className="flex-1 flex flex-col min-w-0">
                    <header
                        className="h-14 border-b bg-card/80 backdrop-blur-sm flex items-center px-4 sticky top-0 z-30">
                        <SidebarTrigger className="mr-4" />
                        <div className="flex-1" />
                        <UpdateNotification />
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="ml-auto mr-2"
                                    title="Theme settings"
                                    aria-label="Change theme"
                                >
                                    {modeIcon}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel>Theme</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={() => setMode('light')}
                                    className={mode === 'light' ? 'bg-accent/10' : ''}
                                >
                                    <Sun className="h-4 w-4 mr-2" />
                                    Light
                                    {mode === 'light' && <span className="ml-auto text-xs text-primary">✓</span>}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => setMode('dark')}
                                    className={mode === 'dark' ? 'bg-accent/10' : ''}
                                >
                                    <Moon className="h-4 w-4 mr-2" />
                                    Dark
                                    {mode === 'dark' && <span className="ml-auto text-xs text-primary">✓</span>}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => setMode('system')}
                                    className={mode === 'system' ? 'bg-accent/10' : ''}
                                >
                                    <Monitor className="h-4 w-4 mr-2" />
                                    System
                                    {mode === 'system' && <span className="ml-auto text-xs text-primary">✓</span>}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => setMode('schedule')}
                                    className={mode === 'schedule' ? 'bg-accent/10' : ''}
                                >
                                    <Clock className="h-4 w-4 mr-2" />
                                    Schedule
                                    {mode === 'schedule' && <span className="ml-auto text-xs text-primary">✓</span>}
                                </DropdownMenuItem>
                                {mode === 'schedule' && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <div className="px-3 py-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                                            <div className="flex items-center gap-2">
                                                <Sun className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                                <Label className="text-xs text-muted-foreground w-14 shrink-0">Light at</Label>
                                                <Input
                                                    type="time"
                                                    value={schedule.lightFrom}
                                                    onChange={(e) => setSchedule({ ...schedule, lightFrom: e.target.value })}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Moon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                                                <Label className="text-xs text-muted-foreground w-14 shrink-0">Dark at</Label>
                                                <Input
                                                    type="time"
                                                    value={schedule.darkFrom}
                                                    onChange={(e) => setSchedule({ ...schedule, darkFrom: e.target.value })}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                        </div>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSettingsOpen(true)}
                            className="ml-2"
                            title="Dashboard Settings"
                            aria-label="Open dashboard settings"
                        >
                            <Settings className="h-5 w-5" />
                        </Button>
                    </header>
                    <main className="flex-1 p-6">
                        <UpcomingPaymentsNotification />
                        {children}
                    </main>
                </div>
            </div>
            <DashboardSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
            {!onboardingLoading && (
                <OnboardingWizard open={!onboardingComplete} onComplete={completeOnboarding} />
            )}
        </SidebarProvider>
    );
}
