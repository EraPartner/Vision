import {Toaster} from "@/components/ui/toaster";
import {Toaster as Sonner} from "@/components/ui/sonner";
import {TooltipProvider} from "@/components/ui/tooltip";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter, Route, Routes} from "react-router-dom";
import {AppLayout} from "@/components/layout/AppLayout";
import {SettingsProvider} from "@/contexts/SettingsContext";
import {ThemeProvider} from "@/contexts/ThemeContext";
import DashboardPage from "./pages/DashboardPage";
import TransactionsPage from "./pages/TransactionsPage";
import CategoriesPage from "./pages/CategoriesPage";
import RecipientsPage from "./pages/RecipientsPage";
import ImportPage from "./pages/ImportPage";
import PlannedPaymentsPage from "./pages/PlannedPaymentsPage";
import StatisticsPage from "./pages/StatisticsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <SettingsProvider>
                    <TooltipProvider>
                        <Toaster/>
                        <Sonner/>
                        <BrowserRouter
                            future={{
                                v7_startTransition: true,
                                v7_relativeSplatPath: true,
                            }}
                        >
                            <AppLayout>
                                <Routes>
                                    <Route path="/" element={<DashboardPage/>}/>
                                    <Route path="/transactions" element={<TransactionsPage/>}/>
                                    <Route path="/categories" element={<CategoriesPage/>}/>
                                    <Route path="/recipients" element={<RecipientsPage/>}/>
                                    <Route path="/planned" element={<PlannedPaymentsPage/>}/>
                                    <Route path="/statistics" element={<StatisticsPage/>}/>
                                    <Route path="/import" element={<ImportPage/>}/>
                                    <Route path="*" element={<NotFound/>}/>
                                </Routes>
                            </AppLayout>
                        </BrowserRouter>
                    </TooltipProvider>
                </SettingsProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
};

export default App;