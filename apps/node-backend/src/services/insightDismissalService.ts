import insightDismissalRepository from "../repositories/insightDismissalRepository.ts";
import { detectCategoryOutliers } from "./categoryOutlierService.ts";
import { NotFoundError } from "../middleware/errorHandler.ts";

export type InsightDismissalInput =
  | { kind: "subscription_new"; recipient_id: number }
  | { kind: "subscription_price_change"; recipient_id: number }
  | { kind: "category_outlier"; category_id: number; month_key: string };

export async function dismissInsight(value: InsightDismissalInput) {
  if (
    value.kind === "subscription_new" ||
    value.kind === "subscription_price_change"
  ) {
    if (
      !(await insightDismissalRepository.recipientExists(value.recipient_id))
    ) {
      throw new NotFoundError("Recipient is no longer available");
    }
    return insightDismissalRepository.upsertSubscription(
      value.kind,
      value.recipient_id,
    );
  }

  const findings = await detectCategoryOutliers();
  const finding = findings.find(
    (item) =>
      Number(item.categoryId) === value.category_id &&
      item.monthKey === value.month_key,
  );
  if (!finding) {
    throw new NotFoundError("Category outlier is no longer active");
  }
  return insightDismissalRepository.upsertOutlier(
    value.category_id,
    value.month_key,
    finding.deviation,
  );
}
