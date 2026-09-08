import insightDismissalRepository from "../repositories/insightDismissalRepository.js";
import { detectCategoryOutliers } from "./categoryOutlierService.js";
import { NotFoundError } from "../middleware/errorHandler.js";

export async function dismissInsight(value) {
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
