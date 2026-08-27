import { getTransactions } from "@/lib/api/transactions";
import type { Transaction } from "@/types/api";

const PAGE_SIZE = 200;
const MAX_PAGES = 3;
const MAX_RESULTS = 5;

export async function fetchRecentDashboardTransactions(
    excludedCategoryIds: readonly number[],
    excludedRecipientIds: readonly number[],
): Promise<Transaction[]> {
    let offset = 0;
    const picked: Transaction[] = [];
    const excludedCategoryIdSet = new Set(excludedCategoryIds);
    const excludedRecipientIdSet = new Set(excludedRecipientIds);

    for (let pageIndex = 0; picked.length < MAX_RESULTS && pageIndex < MAX_PAGES; pageIndex++) {
        const page = await getTransactions({
            limit: PAGE_SIZE,
            offset,
            active: true,
        });

        if (page.items.length === 0) break;

        for (const transaction of page.items) {
            if (transaction.category_id && excludedCategoryIdSet.has(transaction.category_id)) continue;
            if (transaction.recipient_id && excludedRecipientIdSet.has(transaction.recipient_id)) continue;

            picked.push(transaction);
            if (picked.length === MAX_RESULTS) break;
        }

        offset += PAGE_SIZE;
        if (offset >= page.total || page.items.length < PAGE_SIZE) break;
    }

    return picked;
}
