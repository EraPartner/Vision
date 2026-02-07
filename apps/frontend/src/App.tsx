import {Toaster} from "@/components/ui/toaster";
import {Toaster as Sonner} from "@/components/ui/sonner";
import {TooltipProvider} from "@/components/ui/tooltip";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter, Route, Routes} from "react-router-dom";
import {AppLayout} from "@/components/layout/AppLayout";
import DashboardPage from "./pages/DashboardPage";
import TransactionsPage from "./pages/TransactionsPage";
import CategoriesPage from "./pages/CategoriesPage";
import RecipientsPage from "./pages/RecipientsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
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
                            <Route path="*" element={<NotFound/>}/>
                        </Routes>
                    </AppLayout>
                </BrowserRouter>
            </TooltipProvider>
        </QueryClientProvider>
    );
};

export default App;
