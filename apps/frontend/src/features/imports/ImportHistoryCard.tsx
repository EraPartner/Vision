/**
 * ImportHistoryCard — paginated list of import batches with rollback support.
 */

import { useState, useCallback, useEffect } from "react";
import { apiClient } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import { formatDate, parseISO } from "@/components/shared/dateUtils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { History, Loader2, RefreshCw, Undo2 } from "lucide-react";
import type { ImportBatch } from "@/lib/api/types";

const PAGE_SIZE = 10;

const STATUS_VARIANT: Record<
  ImportBatch["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  staging: "secondary",
  validating: "secondary",
  matching: "secondary",
  committing: "secondary",
  complete: "default",
  failed: "destructive",
  aborted: "outline",
};

function BatchStatusBadge({ status }: { status: ImportBatch["status"] }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="capitalize text-xs">
      {status}
    </Badge>
  );
}

function RollbackButton({
  batch,
  onRolledBack,
}: {
  batch: ImportBatch;
  onRolledBack: () => void;
}) {
  const { t } = useLanguage();
  const [rolling, setRolling] = useState(false);

  const canRollback =
    batch.status === "complete" &&
    batch.transactions_remaining > 0;

  if (!canRollback) return null;

  const handleRollback = async () => {
    setRolling(true);
    try {
      const { deleted } = await apiClient.rollbackImportBatch(batch.id);
      toast.success(
        t("importHistory.rollbackSuccess", { n: deleted, id: batch.id }),
      );
      onRolledBack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t("importHistory.rollbackFailed"), { description: msg });
    } finally {
      setRolling(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
          disabled={rolling}
        >
          {rolling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Undo2 className="h-3.5 w-3.5" />
          )}
          <span className="ml-1 text-xs">{t("importHistory.rollback")}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("importHistory.rollbackTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("importHistory.rollbackDesc", {
              n: batch.transactions_remaining,
              file: batch.source_filename ?? `batch #${batch.id}`,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRollback}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("importHistory.rollbackConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BatchRow({
  batch,
  onRolledBack,
}: {
  batch: ImportBatch;
  onRolledBack: () => void;
}) {
  const started = formatDate(parseISO(batch.started_at), "yyyy-MM-dd HH:mm");
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">
            {batch.source_filename ?? `Batch #${batch.id}`}
          </span>
          <BatchStatusBadge status={batch.status} />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <span>{batch.adapter_name}</span>
          <span>{started}</span>
          {batch.rows_imported != null && (
            <>
              <span className="text-success">
                +{batch.rows_imported}
              </span>
              {(batch.rows_duplicate ?? 0) > 0 && (
                <span className="text-warning">
                  {batch.rows_duplicate} dup
                </span>
              )}
              {(batch.rows_error ?? 0) > 0 && (
                <span className="text-destructive">
                  {batch.rows_error} err
                </span>
              )}
            </>
          )}
          {batch.transactions_remaining > 0 && (
            <span className="text-muted-foreground">
              {batch.transactions_remaining} remaining
            </span>
          )}
        </div>
        {batch.error_summary && (
          <p className="text-xs text-destructive truncate max-w-xs">
            {batch.error_summary}
          </p>
        )}
      </div>
      <RollbackButton batch={batch} onRolledBack={onRolledBack} />
    </div>
  );
}

export function ImportHistoryCard({ refreshKey }: { refreshKey?: number }) {
  const { t } = useLanguage();
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [internalRefreshKey, setInternalRefreshKey] = useState(0);

  const load = useCallback(async (currentOffset: number) => {
    setLoading(true);
    try {
      const data = await apiClient.listImportBatches(PAGE_SIZE, currentOffset);
      setBatches(data.batches);
      setTotal(data.total);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t("importHistory.loadFailed"), { description: msg });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load(offset);
  }, [load, offset, refreshKey, internalRefreshKey]);

  const handleRolledBack = useCallback(() => {
    setInternalRefreshKey((k) => k + 1);
  }, []);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              {t("importHistory.title")}
            </CardTitle>
            <CardDescription>{t("importHistory.desc")}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setInternalRefreshKey((k) => k + 1)}
            disabled={loading}
            title={t("common.refresh")}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && batches.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {t("importHistory.empty")}
          </p>
        ) : (
          <>
            <div>
              {batches.map((b) => (
                <BatchRow key={b.id} batch={b} onRolledBack={handleRolledBack} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-2">
                <p className="text-xs text-muted-foreground">
                  {t("importHistory.page", { page: currentPage, total: totalPages })}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0 || loading}
                  >
                    {t("common.previous")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={offset + PAGE_SIZE >= total || loading}
                  >
                    {t("common.next")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
