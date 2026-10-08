import { memo } from "react";
import { Bot, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { ChatMessage } from "@/types/aiChat";
import { ToolResultCard } from "./ToolResultCard";

interface ChatBubbleProps {
    message: ChatMessage;
    streaming?: boolean;
}

// Memoized: `combined` in ChatMessageList keeps completed message identities
// stable across streamed token chunks, so every completed bubble (including the
// tool cards and their charts) bails out of re-render — only the streaming draft
// bubble, whose `message`/`streaming` props actually change, re-renders.
export const ChatBubble = memo(function ChatBubble({
    message,
    streaming = false,
}: ChatBubbleProps) {
    if (message.role === "tool") {
        return <ToolBubble message={message} />;
    }
    return <TextBubble message={message} streaming={streaming} />;
});

function TextBubble({
    message,
    streaming,
}: {
    message: ChatMessage;
    streaming: boolean;
}) {
    const isUser = message.role === "user";
    const content = message.content ?? "";
    return (
        <div
            className={cn(
                "flex gap-3 px-1",
                isUser ? "flex-row-reverse" : "flex-row",
            )}
        >
            <Avatar role={message.role} />
            {isUser ? (
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-card corner-continuous bg-primary px-4 py-2.5 type-body leading-relaxed text-primary-foreground shadow-elevation-1">
                    {content}
                </div>
            ) : (
                <Card className="max-w-[85%] whitespace-pre-wrap break-words px-4 py-2.5 type-body leading-relaxed">
                    {content}
                    {streaming && (
                        <span
                            aria-hidden="true"
                            className="ml-1 inline-block h-3 w-[2px] bg-primary align-middle motion-safe:animate-pulse"
                        />
                    )}
                </Card>
            )}
        </div>
    );
}

function ToolBubble({ message }: { message: ChatMessage }) {
    const { t } = useLanguage();
    return (
        <div className="flex gap-3 px-1">
            <Avatar role="tool" />
            <Card className="max-w-[90%] flex-1 p-3">
                <div className="mb-2 flex items-center gap-2 type-footnote font-medium text-label-secondary">
                    <Wrench className="h-3 w-3" aria-hidden="true" />
                    <span>{message.toolName ?? t("aiChat.toolResult")}</span>
                </div>
                {message.toolResult ? (
                    <ToolResultCard
                        toolName={message.toolName}
                        result={message.toolResult}
                    />
                ) : (
                    <p className="type-footnote text-label-secondary">
                        {t("aiChat.noDataReturned")}
                    </p>
                )}
            </Card>
        </div>
    );
}

export function Avatar({ role }: { role: ChatMessage["role"] }) {
    const base =
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1";
    if (role === "user") {
        return (
            <div
                aria-hidden="true"
                className={cn(base, "bg-primary/15 text-primary ring-primary/30")}
            >
                <User className="h-4 w-4" />
            </div>
        );
    }
    if (role === "tool") {
        return (
            <div
                aria-hidden="true"
                className={cn(
                    base,
                    "bg-foreground/[0.06] text-label-secondary ring-border/50",
                )}
            >
                <Wrench className="h-4 w-4" />
            </div>
        );
    }
    return (
        <div
            aria-hidden="true"
            className={cn(base, "bg-primary/12 text-primary ring-border/50")}
        >
            <Bot className="h-4 w-4" />
        </div>
    );
}
