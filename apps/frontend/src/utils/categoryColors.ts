/**
 * Utility function to map category names to Tailwind color classes
 * Works with both GENERAL and GENERAL:DETAIL formats (e.g., 'FOOD:GROCERIES')
 */
export const getCategoryColor = (category: string): string => {
    if (!category) return "bg-muted/15 text-muted-foreground border-muted/30";

    // // Prefer the general part when category is in the form GENERAL:DETAIL
    // const parts = category.split(":").map(p => p.trim());
    // const general = parts[0] || category;
    //
    // const upperGeneral = general.toUpperCase();
    // const upperCategory = category.toUpperCase();
    //
    // // Check general part first so 'ontspanning:restaurant' is classified as 'ontspanning' (entertainment)
    // if (upperGeneral.includes('FOOD') || upperGeneral.includes('GROCERIES')) {
    //     return "bg-primary/15 text-primary border-primary/30";
    // }
    // // Dutch term mapping: 'ONTSPANNING' ~ leisure/entertainment
    // if (upperGeneral.includes('ONTSPANNING') || upperGeneral.includes('ENTERTAINMENT') || upperGeneral.includes('LEISURE')) {
    //     return "bg-chart-4/15 text-chart-4 border-chart-4/30";
    // }
    // if (upperGeneral.includes('INCOME') || upperGeneral.includes('SALARY')) {
    //     return "bg-accent/15 text-accent border-accent/30";
    // }
    // if (upperGeneral.includes('UTILITIES') || upperGeneral.includes('BILLS')) {
    //     return "bg-chart-3/15 text-chart-3 border-chart-3/30";
    // }
    //
    // // If general didn't match, fall back to checking whole category (detail may contain keywords like RESTAURANT)
    // if (upperCategory.includes('DINING') || upperCategory.includes('RESTAURANT')) {
    //     return "bg-chart-5/15 text-chart-5 border-chart-5/30";
    // }
    // if (upperCategory.includes('TRANSPORT') || upperCategory.includes('TRAVEL')) {
    //     return "bg-chart-4/15 text-chart-4 border-chart-4/30";
    // }
    // if (upperCategory.includes('SHOPPING') || upperCategory.includes('RETAIL')) {
    //     return "bg-primary/15 text-primary border-primary/30";
    // }
    // if (upperCategory.includes('HEALTH') || upperCategory.includes('MEDICAL')) {
    //     return "bg-destructive/15 text-destructive border-destructive/30";
    // }
    // if (upperCategory.includes('ENTERTAINMENT') || upperCategory.includes('LEISURE')) {
    //     return "bg-chart-4/15 text-chart-4 border-chart-4/30";
    // }

    // Default color for uncategorized or unknown categories
    return "bg-muted/15 text-muted-foreground border-muted/30";
};