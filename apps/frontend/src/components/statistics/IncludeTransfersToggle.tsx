import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api";
import { usePreloadedSetting } from "@/contexts/SettingsPreloadContext";
import { useLanguage } from "@/contexts/LanguageContext";
import logger from "@/lib/logger";

/**
 * Toggle for the `includeTransfers` setting (ADR-083). Off (default) excludes
 * internal transfers between the user's own accounts from income/spending; on
 * re-includes them. Invalidates cached queries so the figures refresh.
 */
export function IncludeTransfersToggle() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { value, isLoading } = usePreloadedSetting<boolean>("includeTransfers");
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!isLoading) setOn(value === true);
  }, [value, isLoading]);

  const handleChange = async (next: boolean) => {
    setOn(next);
    try {
      await apiClient.saveSetting("includeTransfers", next);
      await queryClient.invalidateQueries();
    } catch (err) {
      logger.error("Failed to save includeTransfers setting:", err);
      setOn(!next);
    }
  };

  return (
    <div
      className="flex items-center gap-2"
      title={t("transfers.includeTransfersHint")}
    >
      <Switch
        id="include-transfers"
        checked={on}
        disabled={isLoading}
        onCheckedChange={handleChange}
      />
      <label
        htmlFor="include-transfers"
        className="text-sm text-muted-foreground cursor-pointer select-none"
      >
        {t("transfers.includeTransfers")}
      </label>
    </div>
  );
}
