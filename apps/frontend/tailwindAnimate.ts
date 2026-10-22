/**
 * Enter/exit animation utilities (`animate-in`, `fade-in-0`, `zoom-in-95`,
 * `slide-in-from-top-2`, …) used by the Radix-based UI primitives.
 *
 * src/index.css excludes this file from Tailwind source scanning, so the
 * utility names written here do not generate CSS on their own.
 * Kept in the repo instead of the `tailwindcss-animate` package (ADR-245).
 * Port of tailwindcss-animate 1.0.7, MIT License, Copyright (c) 2020 Jamie
 * Kyle; the generated CSS is unchanged.
 */
import plugin from "tailwindcss/plugin";

type CssValue = string | number;
type Scale = Record<string, CssValue>;

function withoutDefault(values: Scale): Scale {
    return Object.fromEntries(Object.entries(values).filter(([key]) => key !== "DEFAULT"));
}

export const tailwindAnimate = plugin(
    ({ addUtilities, matchUtilities, theme }) => {
        const scale = (key: string) => (theme(key) ?? {}) as Scale;
        addUtilities({
            "@keyframes enter": theme("keyframes.enter"),
            "@keyframes exit": theme("keyframes.exit"),
            ".animate-in": {
                animationName: "enter",
                animationDuration: theme("animationDuration.DEFAULT"),
                "--tw-enter-opacity": "initial",
                "--tw-enter-scale": "initial",
                "--tw-enter-rotate": "initial",
                "--tw-enter-translate-x": "initial",
                "--tw-enter-translate-y": "initial",
            },
            ".animate-out": {
                animationName: "exit",
                animationDuration: theme("animationDuration.DEFAULT"),
                "--tw-exit-opacity": "initial",
                "--tw-exit-scale": "initial",
                "--tw-exit-rotate": "initial",
                "--tw-exit-translate-x": "initial",
                "--tw-exit-translate-y": "initial",
            },
        });
        matchUtilities(
            {
                "fade-in": (value) => ({ "--tw-enter-opacity": value }),
                "fade-out": (value) => ({ "--tw-exit-opacity": value }),
            },
            { values: scale("animationOpacity") },
        );
        matchUtilities(
            {
                "zoom-in": (value) => ({ "--tw-enter-scale": value }),
                "zoom-out": (value) => ({ "--tw-exit-scale": value }),
            },
            { values: scale("animationScale") },
        );
        matchUtilities(
            {
                "spin-in": (value) => ({ "--tw-enter-rotate": value }),
                "spin-out": (value) => ({ "--tw-exit-rotate": value }),
            },
            { values: scale("animationRotate") },
        );
        matchUtilities(
            {
                "slide-in-from-top": (value) => ({ "--tw-enter-translate-y": `-${value}` }),
                "slide-in-from-bottom": (value) => ({ "--tw-enter-translate-y": value }),
                "slide-in-from-left": (value) => ({ "--tw-enter-translate-x": `-${value}` }),
                "slide-in-from-right": (value) => ({ "--tw-enter-translate-x": value }),
                "slide-out-to-top": (value) => ({ "--tw-exit-translate-y": `-${value}` }),
                "slide-out-to-bottom": (value) => ({ "--tw-exit-translate-y": value }),
                "slide-out-to-left": (value) => ({ "--tw-exit-translate-x": `-${value}` }),
                "slide-out-to-right": (value) => ({ "--tw-exit-translate-x": value }),
            },
            { values: scale("animationTranslate") },
        );
        matchUtilities(
            { duration: (value) => ({ animationDuration: value }) },
            { values: withoutDefault(scale("animationDuration")) },
        );
        matchUtilities(
            { delay: (value) => ({ animationDelay: value }) },
            { values: scale("animationDelay") },
        );
        matchUtilities(
            { ease: (value) => ({ animationTimingFunction: value }) },
            { values: withoutDefault(scale("animationTimingFunction")) },
        );
        addUtilities({
            ".running": { animationPlayState: "running" },
            ".paused": { animationPlayState: "paused" },
        });
        matchUtilities(
            { "fill-mode": (value) => ({ animationFillMode: value }) },
            { values: scale("animationFillMode") },
        );
        matchUtilities(
            { direction: (value) => ({ animationDirection: value }) },
            { values: scale("animationDirection") },
        );
        matchUtilities(
            { repeat: (value) => ({ animationIterationCount: value }) },
            { values: scale("animationRepeat") },
        );
    },
    {
        theme: {
            extend: {
                animationDelay: ({ theme }) => ({ ...theme("transitionDelay") }),
                animationDuration: ({ theme }) => ({ 0: "0ms", ...theme("transitionDuration") }),
                animationTimingFunction: ({ theme }) => ({ ...theme("transitionTimingFunction") }),
                animationFillMode: {
                    none: "none",
                    forwards: "forwards",
                    backwards: "backwards",
                    both: "both",
                },
                animationDirection: {
                    normal: "normal",
                    reverse: "reverse",
                    alternate: "alternate",
                    "alternate-reverse": "alternate-reverse",
                },
                animationOpacity: ({ theme }) => ({ DEFAULT: 0, ...theme("opacity") }),
                animationTranslate: ({ theme }) => ({ DEFAULT: "100%", ...theme("translate") }),
                animationScale: ({ theme }) => ({ DEFAULT: 0, ...theme("scale") }),
                animationRotate: ({ theme }) => ({ DEFAULT: "30deg", ...theme("rotate") }),
                animationRepeat: { 0: "0", 1: "1", infinite: "infinite" },
                keyframes: {
                    enter: {
                        from: {
                            opacity: "var(--tw-enter-opacity, 1)",
                            transform:
                                "translate3d(var(--tw-enter-translate-x, 0), var(--tw-enter-translate-y, 0), 0) scale3d(var(--tw-enter-scale, 1), var(--tw-enter-scale, 1), var(--tw-enter-scale, 1)) rotate(var(--tw-enter-rotate, 0))",
                        },
                    },
                    exit: {
                        to: {
                            opacity: "var(--tw-exit-opacity, 1)",
                            transform:
                                "translate3d(var(--tw-exit-translate-x, 0), var(--tw-exit-translate-y, 0), 0) scale3d(var(--tw-exit-scale, 1), var(--tw-exit-scale, 1), var(--tw-exit-scale, 1)) rotate(var(--tw-exit-rotate, 0))",
                        },
                    },
                },
            },
        },
    },
);
