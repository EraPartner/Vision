// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("coarse-pointer row actions", () => {
    it("keeps revealed action buttons on the 40px house target", () => {
        for (const file of [
            "src/components/shared/AttachmentPanel.tsx",
            "src/features/ai-chat/ChatConversationList.tsx",
        ]) {
            const contents = readFileSync(join(process.cwd(), file), "utf8");
            expect(contents).toContain("[@media(pointer:coarse)]:opacity-100");
            expect(contents).toContain("icon-touch-target");
        }
    });
});
