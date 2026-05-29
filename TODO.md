# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] 🔽 Visually spot-check `apps/frontend/src/components/ui/calendar.tsx` in the running app after its react-day-picker v10 migration ([[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]). The code migration is **done** — v10 `classNames` keys, the `Chevron` component, and the removed temporary cast (typecheck + 1,379 frontend tests green) — but the theme (selected/today/range styling, nav button positioning) has not been confirmed visually. 🛫 2026-05-29

