/**
 * `bun:test`'s fake-clock control, available in plain Bun programs too: the parity
 * recorder pins an area's recording day with it (`native-parity.ts`).
 */
declare module "bun:test" {
  export function setSystemTime(date: number | Date): void;
}
