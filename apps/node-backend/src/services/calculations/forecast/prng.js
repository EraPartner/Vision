/**
 * Seeded PRNG for deterministic Monte Carlo paths.
 * 32-bit xorshift, seeded via FNV-1a hash of a string key.
 * Deterministic output ⇒ repeat fetches of the same (user, month, filter)
 * yield identical paths (plan requirement).
 */

/** @param {string} str */
export function fnv1aHash(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * @param {number|string} seedInput
 * @returns {() => number}
 */
export function makeRng(seedInput) {
  let state = typeof seedInput === 'number' ? seedInput >>> 0 : fnv1aHash(String(seedInput));
  if (state === 0) state = 1;
  return function next() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return (state >>> 0) / 0x100000000;
  };
}

/** @param {() => number} rng */
export function gaussian(rng) {
  // Box-Muller. Returns one N(0,1) per call; pair-caching not needed at our scale.
  let u1 = rng();
  const u2 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export default { fnv1aHash, makeRng, gaussian };
