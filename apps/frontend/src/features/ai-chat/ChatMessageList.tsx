import { useEffect, useMemo, useRef } from 'react';
import { Bot } from 'lucide-react';
import type { ChatMessage } from '@/types/aiChat';
import { ChatBubble } from './ChatBubble';
import { useLanguage } from '@/contexts/LanguageContext';
import { isOptimisticUserId } from '@/lib/aiChatStreamStore';

interface ChatMessageListProps {
    messages: ChatMessage[];
    streamingUserMessage: ChatMessage | null;
    streamingToolMessages: ChatMessage[];
    assistantDraft: string;
    isStreaming: boolean;
    emptyState?: React.ReactNode;
    /**
     * Id of the conversation being displayed. Only used to re-pin the
     * auto-scroll when the transcript is swapped wholesale — see
     * `isPinnedRef` below.
     */
    conversationId?: string | null;
}

/**
 * Slack, in CSS pixels, for the "is the view flush with the bottom?" test.
 * `scrollHeight`, `scrollTop` and `clientHeight` are each rounded to integers
 * independently while the underlying layout is fractional, so on a zoomed or
 * HiDPI display `scrollTop + clientHeight === scrollHeight` is never reliably
 * true even when the view *is* at the bottom. 8px absorbs that rounding with
 * room to spare while staying well under one line of chat text (14px text at
 * `leading-relaxed` is ~22px), so it can never swallow a deliberate scroll-up.
 */
const PIN_TOLERANCE_PX = 8;

function isScrolledToBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_TOLERANCE_PX;
}

export function ChatMessageList({
    messages,
    streamingUserMessage,
    streamingToolMessages,
    assistantDraft,
    isStreaming,
    emptyState,
    conversationId,
}: ChatMessageListProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // Whether the view should keep following new content. Deliberately a ref
    // updated from scroll events rather than something recomputed inside the
    // streaming effect below: that effect runs *after* React has appended the
    // new chunk, so `scrollHeight` there is already post-growth and a fresh
    // "am I at the bottom?" reading would answer "no, I'm N px up" for a user
    // who never moved — silently killing follow-the-stream. Scroll events only
    // fire when the scroll position actually changes, so this ref holds the
    // pre-mutation answer at the moment the effect needs it.
    const isPinnedRef = useRef(true);
    const lastScrollTopRef = useRef(0);

    const combined = useMemo<ChatMessage[]>(() => {
        const existing = new Set(messages.map((m) => m.id));
        const extras: ChatMessage[] = [];
        if (streamingUserMessage && !existing.has(streamingUserMessage.id)) {
            // Defensive dedupe: if this is the optimistic placeholder and the
            // real persisted user row already lives in `messages` (e.g. after a
            // refetch on remount), suppress the optimistic to avoid a doubled
            // bubble. Match by role + content since the optimistic id will not
            // collide with any server-issued UUID.
            const isOptimistic = isOptimisticUserId(streamingUserMessage.id);
            const optimisticAlreadyPersisted =
                isOptimistic
                && messages.some(
                    (m) => m.role === 'user' && m.content === streamingUserMessage.content,
                );
            if (!optimisticAlreadyPersisted) {
                extras.push(streamingUserMessage);
            }
        }
        for (const tool of streamingToolMessages) {
            if (!existing.has(tool.id)) extras.push(tool);
        }
        return [...messages, ...extras];
    }, [messages, streamingUserMessage, streamingToolMessages]);

    // A streaming tool message grows its content in place without changing
    // `combined.length`, so length alone isn't enough to keep the view pinned.
    // Track the total streaming-tool content size as well.
    const streamingToolContentLength = useMemo(
        () => streamingToolMessages.reduce(
            (sum, message) => sum + (message.content?.length ?? 0),
            0,
        ),
        [streamingToolMessages],
    );
    // React Query briefly keeps the previous conversation as placeholder data
    // during an uncached switch. The conversation id changes first, then the
    // equal-length replacement transcript arrives in a later commit. Track the
    // last message identity so that second commit gets its own bottom scroll.
    const latestCombinedMessageId = combined.at(-1)?.id;

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        lastScrollTopRef.current = el.scrollTop;
        const onScroll = () => {
            const previousTop = lastScrollTopRef.current;
            const top = el.scrollTop;
            lastScrollTopRef.current = top;
            // Reaching the bottom always re-pins, however you got there.
            if (isScrolledToBottom(el)) {
                isPinnedRef.current = true;
                return;
            }
            // Otherwise only an *upward* move un-pins. This ratchet matters:
            // our own rAF `scrollTo` lands at the bottom on frame N, but its
            // scroll event is not dispatched until frame N+1 — by which time a
            // chunk that arrived in between may already have grown
            // `scrollHeight`. A plain `isScrolledToBottom` reading there would
            // report "not at the bottom", un-pin a user who never touched the
            // scroller, and stop the stream from following for the rest of the
            // answer. Content growth never moves `scrollTop` downward, so
            // gating on direction makes that whole class of race impossible.
            if (top < previousTop) {
                isPinnedRef.current = false;
            }
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, []);

    // Re-pin on the two explicit "show me the newest message" intents, so the
    // guard below can only ever suppress the mid-stream yank it exists for:
    // switching to a different transcript, and the user sending a message
    // (they authored the newest content, so they expect to see it). Note the
    // `undefined` bail-out — `streamingUserMessage` drops back to null when a
    // stream finishes, and re-pinning on *that* transition would yank a
    // scrolled-up reader to the bottom exactly as the answer completes.
    const streamingUserMessageId = streamingUserMessage?.id;
    useEffect(() => {
        if (streamingUserMessageId === undefined) return;
        isPinnedRef.current = true;
    }, [streamingUserMessageId]);

    useEffect(() => {
        isPinnedRef.current = true;
    }, [conversationId]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        // Don't yank a reader who has scrolled up mid-stream back to the
        // bottom on every chunk.
        if (!isPinnedRef.current) return;
        // Defer the scroll write into a rAF so we don't read scrollHeight
        // synchronously right after React mutated the container (forced reflow
        // per streamed chunk); by rAF time the layout is already up to date.
        const raf = requestAnimationFrame(() => {
            el.scrollTo({ top: el.scrollHeight });
        });
        return () => cancelAnimationFrame(raf);
    }, [combined.length, latestCombinedMessageId, assistantDraft, isStreaming, streamingToolContentLength, conversationId]);

    const { t } = useLanguage();
    const showDraft = isStreaming && assistantDraft.length > 0;
    const draftLifecycleKey = showDraft ? conversationId : undefined;
    const draftCreatedAt = useMemo(
        () => draftLifecycleKey !== undefined ? new Date().toISOString() : null,
        [draftLifecycleKey],
    );
    const draftMessage = useMemo<ChatMessage | null>(
        () => showDraft && draftCreatedAt ? {
            id: '__draft__',
            role: 'assistant',
            content: assistantDraft,
            createdAt: draftCreatedAt,
        } : null,
        [assistantDraft, draftCreatedAt, showDraft],
    );
    const showThinking =
        isStreaming
        && assistantDraft.length === 0
        && streamingToolMessages.length === 0;
    const showEmpty = combined.length === 0 && !showDraft && !showThinking;

    return (
        <div
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex-1 overflow-y-auto px-4 py-6"
        >
            {/*
              * Deliberately no `.cv-auto-row` on the bubbles. This scroller is
              * bottom-anchored: the resting position is the end of the
              * transcript, so nearly every bubble sits *above* the viewport and
              * would be skipped at the utility's fixed fallback height. On the
              * first open of a conversation no bubble has a last-remembered
              * size yet, so `scrollHeight` at auto-scroll time is a large
              * underestimate and the "scroll to bottom" write lands partway up
              * the conversation, with no later commit to correct it. The
              * dashboard/statistics sections the utility was written for are
              * top-anchored and below the fold, where that error is harmless.
              */}
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {showEmpty && emptyState}
                {combined.map((message) => (
                    <ChatBubble key={message.id} message={message} />
                ))}
                {draftMessage && (
                    <ChatBubble
                        message={draftMessage}
                        streaming
                    />
                )}
                {showThinking && (
                    <div className="flex items-center gap-3 px-1">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-accent/30 text-primary ring-1 ring-border/50">
                            <Bot className="h-4 w-4" />
                        </div>
                        <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground ring-1 ring-border/50">
                            <span className="inline-flex items-center gap-1">
                                <span className="motion-safe:animate-pulse">{t('aiChat.thinking')}</span>
                                <span className="inline-flex gap-0.5" aria-hidden="true">
                                    <span className="motion-safe:animate-bounce [animation-duration:900ms] [animation-delay:0ms]">.</span>
                                    <span className="motion-safe:animate-bounce [animation-duration:900ms] [animation-delay:300ms]">.</span>
                                    <span className="motion-safe:animate-bounce [animation-duration:900ms] [animation-delay:600ms]">.</span>
                                </span>
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
