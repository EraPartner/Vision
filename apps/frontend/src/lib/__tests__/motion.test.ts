// @vitest-environment node
import { describe, expect, it } from "vitest";
import { staggerContainer, durations, easings, springs, fadeUp } from "@/lib/motion";

describe("staggerContainer", () => {
  it("uses default stagger + delay when called with no args", () => {
    const v = staggerContainer();
    const visible = v.visible as { transition: { staggerChildren: number; delayChildren: number } };
    expect(visible.transition.staggerChildren).toBe(0.06);
    expect(visible.transition.delayChildren).toBe(0);
  });

  it("honours explicit stagger + delay (override branch)", () => {
    const v = staggerContainer(0.2, 0.5);
    const visible = v.visible as { transition: { staggerChildren: number; delayChildren: number } };
    expect(visible.transition.staggerChildren).toBe(0.2);
    expect(visible.transition.delayChildren).toBe(0.5);
  });
});

describe("motion tokens", () => {
  it("exposes the expected duration + easing + spring tokens", () => {
    expect(durations.fast).toBeLessThan(durations.page);
    expect(easings.outExpo).toHaveLength(4);
    expect(springs.dialog.type).toBe("spring");
    expect(fadeUp.hidden).toMatchObject({ opacity: 0 });
  });
});
