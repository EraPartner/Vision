/**
 * Class-name helpers (ADR-245; replace `clsx` and `class-variance-authority`).
 *
 * `cx` joins class values like clsx: strings and numbers as-is, arrays
 * flattened, objects contribute their truthy keys, falsy values are skipped.
 * `cva` builds a variant function like class-variance-authority: base
 * classes, one class per variant (prop, else default; `null` turns a variant
 * off; booleans and 0 select the "true"/"false"/"0" keys), matching compound
 * variants, then `class`/`className`.
 */

export type ClassDictionary = Record<string, unknown>;
export type ClassArray = ClassValue[];
export type ClassValue =
    | ClassArray
    | ClassDictionary
    | string
    | number
    | bigint
    | null
    | boolean
    | undefined;

function append(joined: string, next: string): string {
    return next === "" ? joined : joined === "" ? next : `${joined} ${next}`;
}

/** JavaScript truthiness, spelled out for strict boolean lint. */
function present(value: ClassValue): boolean {
    return value !== undefined && value !== null && value !== false && value !== "" &&
        value !== 0 && value !== 0n && !Number.isNaN(value);
}

function toClass(value: ClassValue): string {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value !== "object" || value === null) return "";
    let joined = "";
    if (Array.isArray(value)) {
        for (const item of value) if (present(item)) joined = append(joined, toClass(item));
        return joined;
    }
    // clsx appends every truthy key, even an empty one, with a separating space.
    for (const key in value) if (value[key]) joined = joined === "" ? key : `${joined} ${key}`;
    return joined;
}

export function cx(...inputs: ClassValue[]): string {
    let joined = "";
    for (const input of inputs) if (present(input)) joined = append(joined, toClass(input));
    return joined;
}

type ClassProp =
    | { class: ClassValue; className?: never }
    | { class?: never; className: ClassValue }
    | { class?: never; className?: never };
type StringToBoolean<T> = T extends "true" | "false" ? boolean : T;
type VariantSchema = Record<string, Record<string, ClassValue>>;
type VariantSelection<T extends VariantSchema> = {
    [Variant in keyof T]?: StringToBoolean<keyof T[Variant]> | null | undefined;
};
type CompoundSelection<T extends VariantSchema> = {
    [Variant in keyof T]?:
        | StringToBoolean<keyof T[Variant]>
        | StringToBoolean<keyof T[Variant]>[]
        | undefined;
};
type VariantConfig<T> = T extends VariantSchema
    ? {
          variants?: T;
          defaultVariants?: VariantSelection<T>;
          compoundVariants?: ((VariantSelection<T> | CompoundSelection<T>) & ClassProp)[];
      }
    : never;
type VariantInput<T> = T extends VariantSchema
    ? VariantSelection<T> & ClassProp
    : ClassProp;

/** Props a `cva()` function accepts, without `class`/`className`. */
export type VariantProps<Component extends (...args: never[]) => unknown> = Omit<
    Exclude<Parameters<Component>[0], undefined>,
    "class" | "className"
>;

function variantKey(value: unknown): unknown {
    if (typeof value === "boolean") return String(value);
    return value === 0 ? "0" : value;
}

export function cva<T>(base?: ClassValue, config?: VariantConfig<T>) {
    return (props?: VariantInput<T>): string => {
        // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
        const input = (props ?? {}) as Record<string, unknown>;
        // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
        const variants = config?.variants as VariantSchema | undefined;
        // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
        if (variants == null) return cx(base, input.class as ClassValue, input.className as ClassValue);
        // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
        const defaults = (config?.defaultVariants ?? {}) as Record<string, unknown>;
        const chosen = Object.keys(variants).map((variant) => {
            const value = input[variant];
            if (value === null) return null;
            // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
            const key = (variantKey(value) || variantKey(defaults[variant])) as string;
            return variants[variant]?.[key];
        });
        const given = Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
        );
        const selected: Record<string, unknown> = { ...defaults, ...given };
        const compound: ClassValue[] = [];
        // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
        for (const entry of (config?.compoundVariants ?? []) as Record<string, unknown>[]) {
            const { class: cvClass, className: cvClassName, ...conditions } = entry;
            const matches = Object.entries(conditions).every(([key, value]) =>
                Array.isArray(value) ? value.includes(selected[key]) : selected[key] === value,
            );
            // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
            if (matches) compound.push(cvClass as ClassValue, cvClassName as ClassValue);
        }
        return cx(
            base,
            chosen,
            compound,
            // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
            input.class as ClassValue,
            // cva-compatible dynamic API: props, variants and compound variants are user-supplied records read by key.
            input.className as ClassValue,
        );
    };
}
