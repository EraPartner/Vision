export const SANKEY_RESERVED_LABEL_KEYS: Readonly<Record<string, string>> = {
    __income__: "statsPage.sankey.income",
    __spending__: "statsPage.sankey.spending",
    __funding_gap__: "statsPage.sankey.fundingGap",
    __uncategorised__: "statsPage.sankey.uncategorised",
    __other__: "statsPage.sankey.other",
    __savings__: "statsPage.sankey.savings",
};

export function localizeSankeyLabel(
    id: string,
    label: string,
    translate: (key: string) => string,
): string {
    const key = SANKEY_RESERVED_LABEL_KEYS[id];
    return key ? translate(key) : label;
}

export function sankeyColorKey(id: string, label: string): string {
    return id.startsWith("cat:") ? label : id;
}
