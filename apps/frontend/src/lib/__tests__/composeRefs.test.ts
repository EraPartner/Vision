/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { composeRefs } from "@/lib/composeRefs";

describe("composeRefs", () => {
  it("invokes function refs with the node", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const node = {} as HTMLElement;
    composeRefs<HTMLElement>(fnA, fnB)(node);
    expect(fnA).toHaveBeenCalledWith(node);
    expect(fnB).toHaveBeenCalledWith(node);
  });

  it("assigns object refs' .current", () => {
    const objRef = { current: null } as React.MutableRefObject<HTMLElement | null>;
    const node = {} as HTMLElement;
    composeRefs<HTMLElement>(objRef)(node);
    expect(objRef.current).toBe(node);
  });

  it("skips undefined/null refs without throwing", () => {
    const fn = vi.fn();
    const node = {} as HTMLElement;
    expect(() => composeRefs<HTMLElement>(undefined, null as never, fn)(node)).not.toThrow();
    expect(fn).toHaveBeenCalledWith(node);
  });

  it("propagates a null node to all refs (unmount)", () => {
    const fn = vi.fn();
    const objRef = { current: {} } as React.MutableRefObject<HTMLElement | null>;
    composeRefs<HTMLElement>(fn, objRef)(null);
    expect(fn).toHaveBeenCalledWith(null);
    expect(objRef.current).toBeNull();
  });
});
