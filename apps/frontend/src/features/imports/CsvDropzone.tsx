/**
 * CsvDropzone — the shared click/drag-and-drop CSV file picker used by every
 * import surface (transactions, portfolio, recipients, categories). Validates
 * with the shared isCsvFile guard and shows the selected file with a remove
 * action. `compact` renders the smaller single-line variant used inside the
 * recipients/categories cards; the default is the larger page/card variant.
 */

import { useCallback, useRef, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CloudUpload, File as FileIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { isCsvFile } from "./csvFile";
import { cn } from "@/lib/utils";

interface CsvDropzoneProps {
  file: File | null;
  onFileSelect: (file: File | null) => void;
  /** Smaller padding/icon + single-line hint (used inside the simpler cards). */
  compact?: boolean;
  /** Optional bold field label rendered above the dropzone. */
  label?: string;
}

export function CsvDropzone({ file, onFileSelect, compact = false, label }: CsvDropzoneProps) {
  const { t } = useLanguage();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (f: File | null) => {
      if (f && !isCsvFile(f)) {
        toast.error(t("importPage.toast.noFile"));
        return;
      }
      onFileSelect(f);
    },
    [onFileSelect, t],
  );

  const pad = compact ? "p-8" : "p-10";
  const iconSize = compact ? "h-8 w-8" : "h-10 w-10";

  return (
    <div className="space-y-2">
      {label && <Label className="font-semibold">{label}</Label>}
      <div
        data-dropzone
        onClick={() => inputRef.current?.click()}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          accept(e.dataTransfer.files?.[0] ?? null);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        className={cn(
          "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed",
          pad,
          "cursor-pointer transition-colors duration-200",
          dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/50",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => accept(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <>
            <FileIcon className={cn(iconSize, "text-primary")} />
            <div className="text-center">
              <p className="font-medium text-foreground">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} {t("common.kb")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onFileSelect(null);
              }}
            >
              <Trash2 className="h-4 w-4 mr-1" /> {t("importPage.remove")}
            </Button>
          </>
        ) : compact ? (
          <>
            <CloudUpload className={cn(iconSize, "text-muted-foreground")} />
            <p className="text-sm text-muted-foreground">{t("importPage.dropzoneSmall")}</p>
          </>
        ) : (
          <>
            <CloudUpload className={cn(iconSize, "text-muted-foreground")} />
            <div className="text-center">
              <p className="font-medium text-foreground">{t("importPage.dropzone")}</p>
              <p className="text-sm text-muted-foreground">{t("importPage.dropzoneOr")}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
