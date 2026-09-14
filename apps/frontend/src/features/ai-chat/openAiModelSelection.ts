import type { OpenAiResearchModel } from "@/lib/api/aiResearch";

interface ResolveOpenAiModelInput {
    override: string | null;
    userDefault: string | undefined;
    serverDefault: string;
    models: OpenAiResearchModel[];
}

export function resolveOpenAiModel({
    override,
    userDefault,
    serverDefault,
    models,
}: ResolveOpenAiModelInput): string {
    const allowed = new Set(models.map((model) => model.id));
    return (
        [override, userDefault, serverDefault].find(
            (candidate): candidate is string =>
                Boolean(candidate && allowed.has(candidate)),
        ) ??
        models[0]?.id ??
        ""
    );
}
