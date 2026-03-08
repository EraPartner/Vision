import {Toaster} from "@/components/ui/toaster";
import {Toaster as Sonner} from "@/components/ui/sonner";
import {TooltipProvider} from "@/components/ui/tooltip";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter, Route, Routes} from "react-router-dom";
import {AppLayout} from "@/components/layout/AppLayout";
import {SettingsProvider} from "@/contexts/SettingsContext";
import {ThemeProvider} from "@/contexts/ThemeContext";
import {WorkspaceProvider} from "@/contexts/WorkspaceContext";
import DashboardPage from "./pages/DashboardPage";
import TransactionsPage from "./pages/TransactionsPage";
import CategoriesPage from "./pages/CategoriesPage";
import RecipientsPage from "./pages/RecipientsPage";
import ImportPage from "./pages/ImportPage";
import PlannedPaymentsPage from "./pages/PlannedPaymentsPage";
import StatisticsPage from "./pages/StatisticsPage";
import PortfolioOverviewPage from "./pages/portfolio/PortfolioOverviewPage";
import StocksPage from "./pages/portfolio/StocksPage";
import CryptoPage from "./pages/portfolio/CryptoPage";
import RealEstatePage from "./pages/portfolio/RealEstatePage";
import SavingsPage from "./pages/portfolio/SavingsPage";
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
                            <WorkspaceProvider>
                                <AppLayout>
                                    <Routes>
                                        {/* Budgeting */}
                                        <Route path="/" element={<DashboardPage/>}/>
                                        <Route path="/transactions" element={<TransactionsPage/>}/>
                                        <Route path="/categories" element={<CategoriesPage/>}/>
                                        <Route path="/recipients" element={<RecipientsPage/>}/>
                                        <Route path="/planned" element={<PlannedPaymentsPage/>}/>
                                        <Route path="/statistics" element={<StatisticsPage/>}/>
                                        <Route path="/import" element={<ImportPage/>}/>
                                        {/* Portfolio */}
                                        <Route path="/portfolio" element={<PortfolioOverviewPage/>}/>
                                        <Route path="/portfolio/stocks" element={<StocksPage/>}/>
                                        <Route path="/portfolio/crypto" element={<CryptoPage/>}/>
                                        <Route path="/portfolio/real-estate" element={<RealEstatePage/>}/>
                                        <Route path="/portfolio/savings" element={<SavingsPage/>}/>
                                        <Route path="*" element={<NotFound/>}/>
                                    </Routes>
                                </AppLayout>
                            </WorkspaceProvider>
                        </BrowserRouter>
                    </TooltipProvider>
                </SettingsProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
};

export default App;
