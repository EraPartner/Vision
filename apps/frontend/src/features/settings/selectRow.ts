import type { SelectRowConfig } from "./SettingsPrimitives";

/**
 * Widens a row config with a literal-union value to the plain `SelectRowConfig`
 * so rows of different unions can share one array.
 */
export function selectRow<T extends string>(
    row: SelectRowConfig<T>,
): SelectRowConfig {
    return {
        ...row,
        onValueChange: (next) => {
            const picked = row.options.find((o) => o.value === next);
            if (picked) row.onValueChange(picked.value);
        },
    };
}
