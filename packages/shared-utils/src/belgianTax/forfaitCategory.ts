import type { ActivityKind, ForfaitCategory } from "./householdTypes.ts";

/**
 * Art. 51 forfait category of an activity kind. Kept apart from the household engine so the
 * shape helpers (migration, v1 projection, editors) can use it without loading the engine.
 */
export function forfaitCategoryOf(kind: ActivityKind): ForfaitCategory {
    switch (kind) {
        case "employee":
        case "civil_servant":
            return "remuneration";
        case "director":
            return "director";
        case "self_employed_profits":
            return "profits";
        case "self_employed_fees":
            return "fees";
        case "helping_spouse":
            return "helping_spouse";
        default:
            return "none";
    }
}
