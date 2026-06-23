// Phase F5 — chaos / fault injection for MSW.
//
// Wraps a handler with random failure modes: occasional 5xx, latency spikes,
// truncated payloads. Use sparingly inside chaos.test.ts to verify the
// frontend stays sane under transient backend faults (no white screen, no
// hung query, no unhandled rejection).
//
// Example:
//   server.use(chaos(http.get(`${API_BASE}/api/transactions`, () => ok({ ... }))));
//
// Tunables come from the env so a single chaos run can be reproduced:
//   VISION_CHAOS_ERROR_RATE=0.3   -- 30% of calls fail with 5xx
//   VISION_CHAOS_LATENCY_MS=200   -- max added latency

import { HttpResponse, type HttpHandler, type HttpResponseResolver } from "msw";

interface ChaosConfig {
    errorRate: number;
    maxLatencyMs: number;
    seed: number;
}

function readConfig(): ChaosConfig {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    return {
        errorRate: Number(env.VISION_CHAOS_ERROR_RATE ?? "0.2"),
        maxLatencyMs: Number(env.VISION_CHAOS_LATENCY_MS ?? "100"),
        seed: Number(env.VISION_CHAOS_SEED ?? Date.now()),
    };
}

// Cheap deterministic PRNG (mulberry32) so chaos tests are reproducible
// when VISION_CHAOS_SEED is held constant.
function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const cfg = readConfig();
const rng = mulberry32(cfg.seed);

/**
 * Wrap an MSW handler with chaos. Calls the original resolver but with
 * `errorRate` chance of replacing the response with a 503, plus up to
 * `maxLatencyMs` of added latency.
 */
export function chaos(handler: HttpHandler): HttpHandler {
    const mutable = handler as unknown as { resolver: HttpResponseResolver };
    const original = mutable.resolver;
    mutable.resolver = async (info) => {
        await new Promise((r) => setTimeout(r, rng() * cfg.maxLatencyMs));
        if (rng() < cfg.errorRate) {
            return HttpResponse.json(
                { ok: false, error: { message: "chaos: synthetic 503", code: "CHAOS_503" } },
                { status: 503 },
            );
        }
        return original(info);
    };
    return handler;
}

export function getChaosConfig(): Readonly<ChaosConfig> {
    return cfg;
}
