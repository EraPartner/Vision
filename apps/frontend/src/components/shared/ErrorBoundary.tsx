import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import logger from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Functional component for translated fallback UI (hooks can't be used in class components)
function ErrorFallback({ error, onReset }: { error: Error | null; onReset: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 p-8 text-center">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-lg font-semibold text-foreground">
        {t('common.errorBoundary')}
      </h2>
      <p className="text-sm text-muted-foreground max-w-md">
        {t('common.errorBoundaryDetail')}
      </p>
      {process.env.NODE_ENV !== "production" && error && (
        <pre className="mt-2 max-w-lg overflow-auto rounded-md bg-muted p-3 text-xs text-left text-muted-foreground">
          {error.message}
        </pre>
      )}
      <div className="flex gap-2 mt-2">
        <Button variant="outline" onClick={onReset}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('common.retry')}
        </Button>
        <Button variant="default" onClick={() => window.location.reload()}>
          {t('common.reload')}
        </Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log to console in development; in production this could go to an error reporting service
    logger.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <ErrorFallback error={this.state.error} onReset={this.handleReset} />
      );
    }

    return this.props.children;
  }
}
