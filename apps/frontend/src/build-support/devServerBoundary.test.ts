import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../../vite.config";
import type { UserConfig } from "vite";

afterEach(() => vi.unstubAllEnvs());
function developmentConfig(): UserConfig {
    return config({
        command: "serve",
        mode: "development",
    });
}

describe("development API proxy network boundary", () => {
    it.each(["", "0.0.0.0", "::"])(
        "keeps the proxy on loopback whatever the environment says (%s)",
        (host) => {
            vi.stubEnv("VISION_VITE_BIND_HOST", host);
            vi.stubEnv("SERVER_HOST", "0.0.0.0");
            const server = developmentConfig().server;
            expect(server?.host).toBe("127.0.0.1");
            expect(server?.allowedHosts).not.toBe(true);
            expect(server?.proxy?.["/api"]).toMatchObject({ changeOrigin: true });
        },
    );
    it("forwards /api to the backend named by the development launcher", () => {
        vi.stubEnv("VISION_DEV_API_TARGET", "http://127.0.0.1:43123");
        const server = developmentConfig().server;
        expect(server?.proxy?.["/api"]).toMatchObject({
            target: "http://127.0.0.1:43123",
        });
    });
});
