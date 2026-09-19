/** Match a direct category observation against one or more selected ancestors. */
export function matchesCategorySelection(
    category: { categoryId: number | null; categoryPathIds?: number[] },
    selectedIds: ReadonlySet<number>,
): boolean {
    if (category.categoryId == null) return false;
    const path = category.categoryPathIds?.length
        ? category.categoryPathIds
        : [category.categoryId];
    return path.some((id) => selectedIds.has(id));
}
