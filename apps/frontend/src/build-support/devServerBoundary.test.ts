import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../../vite.config";
import type { ConfigEnv, UserConfig } from "vite";

afterEach(() => vi.unstubAllEnvs());
function developmentConfig(): UserConfig {
    return (config as (env: ConfigEnv) => UserConfig)({
        command: "serve",
        mode: "development",
    });
}

describe("development API proxy network boundary", () => {
    it("keeps the proxy on loopback on the host regardless of backend bind settings", () => {
        vi.stubEnv("VISION_VITE_BIND_HOST", "");
        vi.stubEnv("SERVER_HOST", "0.0.0.0");
        const server = developmentConfig().server;
        expect(server?.host).toBe("127.0.0.1");
        expect(server?.allowedHosts).not.toBe(true);
        expect(server?.proxy?.["/api"]).toMatchObject({ changeOrigin: true });
    });
    it.each(["0.0.0.0", "::"])(
        "requires explicit opt-in for a container bind %s",
        (host) => {
            vi.stubEnv("VISION_VITE_BIND_HOST", host);
            const server = developmentConfig().server;
            expect(server?.host).toBe(host);
            expect(server?.allowedHosts).not.toBe(true);
        },
    );
});
