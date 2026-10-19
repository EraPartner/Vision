/** Text colour for a signed gain or loss: gain, loss, or neutral at zero. */
export const toneClass = (value: number) =>
    value > 0 ? "text-gain" : value < 0 ? "text-loss" : "text-foreground";
