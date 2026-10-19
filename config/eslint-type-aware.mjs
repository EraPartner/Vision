/**
 * Type-aware lint rules shared by the frontend and backend ESLint configs.
 *
 * They target bug classes the compiler accepts: a promise nobody awaits or
 * handles, a switch that misses a union member, and a number used as a
 * condition or `||` fallback, where 0 (a valid amount) behaves like "missing".
 */
export const typeAwareRules = {
  "@typescript-eslint/switch-exhaustiveness-check": [
    "error",
    { considerDefaultExhaustiveForUnions: true },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": [
    "error",
    { checksVoidReturn: { attributes: false } },
  ],
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/require-array-sort-compare": [
    "error",
    { ignoreStringArrays: true },
  ],
  "@typescript-eslint/restrict-plus-operands": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  // Numbers must be compared explicitly; strings, booleans and nullable
  // objects keep their usual truthiness.
  "@typescript-eslint/strict-boolean-expressions": [
    "error",
    {
      allowString: true,
      allowNumber: false,
      allowNullableObject: true,
      allowNullableBoolean: true,
      allowNullableString: true,
      allowNullableNumber: false,
      allowAny: true,
    },
  ],
  // `amount || fallback` replaces a real 0; `??` only replaces null/undefined.
  "@typescript-eslint/prefer-nullish-coalescing": [
    "error",
    { ignorePrimitives: { string: true, boolean: true } },
  ],
};
