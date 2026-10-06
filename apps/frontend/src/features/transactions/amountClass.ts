/** Amount colour (ADR-181): spending in the text colour, money in as a gain. */
export function amountClass(amount: number): string {
    return amount >= 0 ? "text-gain" : "text-foreground";
}
