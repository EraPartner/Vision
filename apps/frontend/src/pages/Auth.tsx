import { useState } from "react";
import { AuthForm } from "@/components/auth/AuthForm";
import { TrendingUp } from "lucide-react";

export default function Auth() {
  const [mode, setMode] = useState<"login" | "signup">("login");

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="h-12 w-12 rounded-full bg-primary flex items-center justify-center">
              <TrendingUp className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-3xl font-bold">Finance Tracker</h1>
          <p className="text-muted-foreground">
            Take control of your personal finances
          </p>
        </div>
        <AuthForm mode={mode} onToggleMode={() => setMode(mode === "login" ? "signup" : "login")} />
      </div>
    </div>
  );
}