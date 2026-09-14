import { describe, expect, it } from "vitest";
import { resolveOpenAiModel } from "@/features/ai-chat/openAiModelSelection";
import type { OpenAiResearchModel } from "@/lib/api/aiResearch";

const models: OpenAiResearchModel[] = [
    {
        id: "standard",
        label: "Standard",
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        isDefault: true,
    },
    {
        id: "capable",
        label: "More capable",
        inputMicrosPerMillion: 2,
        outputMicrosPerMillion: 8,
        isDefault: false,
    },
];

describe("resolveOpenAiModel", () => {
    it("prefers an explicit investigation override over saved and operator defaults", () => {
        expect(
            resolveOpenAiModel({
                override: "capable",
                userDefault: "standard",
                serverDefault: "standard",
                models,
            }),
        ).toBe("capable");
    });

    it("uses the saved default when no investigation override exists", () => {
        expect(
            resolveOpenAiModel({
                override: null,
                userDefault: "capable",
                serverDefault: "standard",
                models,
            }),
        ).toBe("capable");
    });

    it("ignores stale preferences and falls back within the allowlist", () => {
        expect(
            resolveOpenAiModel({
                override: "removed-override",
                userDefault: "removed-default",
                serverDefault: "standard",
                models,
            }),
        ).toBe("standard");
    });
});
