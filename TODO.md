# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] 🔼 Migrate `apps/frontend/src/components/ui/calendar.tsx` to react-day-picker v10 styling: rename the v8 `classNames` keys (`caption`→`month_caption`, `cell`→`day`, `day`→`day_button`, `nav_button*`→`button_previous`/`button_next`, `head_row`→`weekdays`, `head_cell`→`weekday`, `row`→`week`, `day_selected`→`selected`, etc.) and update the `aria-selected` selectors to v10 `data-*` attributes, then remove the temporary `classNames` cast added in [[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]. Verify the calendar theme visually. 🛫 2026-05-29

