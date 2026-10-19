// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    APP_DOCUMENTATION_URL,
    APP_LICENSE,
    APP_NAME,
    APP_REPOSITORY_URL,
    APP_VERSION,
} from "@/lib/appIdentity";

const readJson = (path: string) =>
    JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as {
        version: string;
    };

describe("application identity", () => {
    it("uses the canonical root version in every package and build-time UI constant", () => {
        const root = readJson("../../package.json");
        const frontend = readJson("package.json");
        const electron = readJson("../../packaging/electron/package.json");

        expect(APP_VERSION).toBe(root.version);
        expect(frontend.version).toBe(root.version);
        expect(electron.version).toBe(root.version);
    });

    it("defines the product, license, source, and documentation identity", () => {
        expect(APP_NAME).toBe("Vision");
        expect(APP_LICENSE).toBe("AGPL-3.0-only");
        expect(APP_REPOSITORY_URL).toBe("https://github.com/EraPartner/Vision");
        expect(APP_DOCUMENTATION_URL).toBe(
            "https://github.com/EraPartner/Vision/tree/main/docs",
        );
    });
});
