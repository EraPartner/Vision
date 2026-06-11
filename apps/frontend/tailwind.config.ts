import type { Config } from "tailwindcss";
import * as tailwindcssAnimateModule from "tailwindcss-animate";

// Handle both CommonJS and ES module exports
const tailwindcssAnimate = (tailwindcssAnimateModule as { default?: typeof tailwindcssAnimateModule }).default || tailwindcssAnimateModule;

export default {
    darkMode: ["class"],
    content: [
        "./src/**/*.{ts,tsx}",
        "./index.html",
    ],
    prefix: "",
    theme: {
        container: {
            center: true,
            padding: "2rem",
            screens: {
                "2xl": "1400px",
            },
        },
        extend: {
            fontFamily: {
                display: [
                    "Fraunces Variable",
                    "Fraunces",
                    "Iowan Old Style",
                    "Palatino",
                    "Georgia",
                    "serif",
                ],
                sans: [
                    "Inter Variable",
                    "Inter",
                    "-apple-system",
                    "BlinkMacSystemFont",
                    "SF Pro Text",
                    "Segoe UI",
                    "system-ui",
                    "sans-serif",
                ],
                mono: [
                    "SF Mono",
                    "JetBrains Mono",
                    "Menlo",
                    "Consolas",
                    "monospace",
                ],
            },
            colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                primary: {
                    DEFAULT: "hsl(var(--primary))",
                    foreground: "hsl(var(--primary-foreground))",
                },
                secondary: {
                    DEFAULT: "hsl(var(--secondary))",
                    foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive))",
                    foreground: "hsl(var(--destructive-foreground))",
                },
                success: "hsl(var(--success))",
                warning: "hsl(var(--warning))",
                expense: "hsl(var(--expense))",
                muted: {
                    DEFAULT: "hsl(var(--muted))",
                    foreground: "hsl(var(--muted-foreground))",
                },
                accent: {
                    DEFAULT: "hsl(var(--accent))",
                    foreground: "hsl(var(--accent-foreground))",
                },
                popover: {
                    DEFAULT: "hsl(var(--popover))",
                    foreground: "hsl(var(--popover-foreground))",
                },
                card: {
                    DEFAULT: "hsl(var(--card))",
                    foreground: "hsl(var(--card-foreground))",
                },
                sidebar: {
                    DEFAULT: "hsl(var(--sidebar-background))",
                    foreground: "hsl(var(--sidebar-foreground))",
                    primary: "hsl(var(--sidebar-primary))",
                    "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
                    accent: "hsl(var(--sidebar-accent))",
                    "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
                    border: "hsl(var(--sidebar-border))",
                    ring: "hsl(var(--sidebar-ring))",
                },
                chart: {
                    "1": "hsl(var(--chart-1))",
                    "2": "hsl(var(--chart-2))",
                    "3": "hsl(var(--chart-3))",
                    "4": "hsl(var(--chart-4))",
                    "5": "hsl(var(--chart-5))",
                    "6": "hsl(var(--chart-6))",
                    "7": "hsl(var(--chart-7))",
                    "8": "hsl(var(--chart-8))",
                },
            },
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
                xl: "calc(var(--radius) + 4px)",
                "2xl": "calc(var(--radius) + 10px)",
            },
            boxShadow: {
                "glass-soft":
                    "0 1px 0 0 hsl(var(--glass-highlight) / 0.35) inset, 0 10px 30px -12px hsl(var(--glass-shadow) / 0.35)",
                "glass-elevated":
                    "0 1px 0 0 hsl(var(--glass-highlight) / 0.5) inset, 0 22px 48px -18px hsl(var(--glass-shadow) / 0.55)",
            },
            transitionTimingFunction: {
                "out-expo": "var(--ease-out-expo)",
                "out-quint": "var(--ease-out-quint)",
                "in-out-quart": "var(--ease-in-out-quart)",
            },
            transitionDuration: {
                fast: "150ms",
                normal: "260ms",
                slow: "420ms",
            },
            keyframes: {
                "accordion-down": {
                    from: { height: "0" },
                    to: { height: "var(--radix-accordion-content-height)" },
                },
                "accordion-up": {
                    from: { height: "var(--radix-accordion-content-height)" },
                    to: { height: "0" },
                },
                "fade-up": {
                    from: { opacity: "0", transform: "translateY(12px)" },
                    to: { opacity: "1", transform: "translateY(0)" },
                },
                "fade-in": {
                    from: { opacity: "0" },
                    to: { opacity: "1" },
                },
                "scale-in": {
                    from: { opacity: "0", transform: "scale(0.96)" },
                    to: { opacity: "1", transform: "scale(1)" },
                },
                shimmer: {
                    "0%": { backgroundPosition: "-200% 0" },
                    "100%": { backgroundPosition: "200% 0" },
                },
                // Dialog enter/exit. Centering lives on the standalone CSS
                // `translate` property (Tailwind v4), so `transform` is free
                // to animate without disturbing position.
                "dialog-in": {
                    from: { opacity: "0", transform: "scale(0.95) translateY(12px)" },
                    to: { opacity: "1", transform: "scale(1) translateY(0)" },
                },
                // Exit reads per-element genie vars (lib/dialogGenie.ts) so a
                // pointer-opened dialog shrinks toward its trigger; the
                // fallbacks reproduce the neutral fade-down for keyboard opens.
                "dialog-out": {
                    from: { opacity: "1", transform: "scale(1) translateY(0)" },
                    to: { opacity: "0", transform: "scale(var(--genie-scale, 0.97)) translateY(var(--genie-y, 6px))" },
                },
            },
            animation: {
                "accordion-down": "accordion-down 0.2s ease-out",
                "accordion-up": "accordion-up 0.2s ease-out",
                "fade-up": "fade-up 420ms var(--ease-out-expo) both",
                "fade-in": "fade-in 260ms var(--ease-out-expo) both",
                "scale-in": "scale-in 260ms var(--ease-out-expo) both",
                shimmer: "shimmer 2.4s linear infinite",
                // Overshooting bezier gives the spring feel without JS.
                "dialog-in": "dialog-in 420ms cubic-bezier(0.34, 1.45, 0.64, 1) both",
                "dialog-out": "dialog-out 200ms var(--ease-out-quint) both",
            },
        },
    },
    plugins: [tailwindcssAnimate],
} satisfies Config;
