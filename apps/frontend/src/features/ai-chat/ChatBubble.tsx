import { Bot, User, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types/aiChat';
import { ToolResultCard } from './ToolResultCard';

interface ChatBubbleProps {
    message: ChatMessage;
    streaming?: boolean;
}

export function ChatBubble({ message, streaming = false }: ChatBubbleProps) {
    if (message.role === 'tool') {
        return <ToolBubble message={message} />;
    }
    return <TextBubble message={message} streaming={streaming} />;
}

function TextBubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
    const isUser = message.role === 'user';
    const content = message.content ?? '';
    return (
        <div
            className={cn(
                'flex gap-3 px-1',
                isUser ? 'flex-row-reverse' : 'flex-row',
            )}
        >
            <Avatar role={message.role} />
            <div
                className={cn(
                    'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words',
                    isUser
                        ? 'bg-primary text-primary-foreground rounded-tr-sm shadow-[0_8px_24px_-12px_hsl(var(--primary)/0.45)]'
                        : 'bg-muted/60 text-foreground rounded-tl-sm ring-1 ring-border/50',
                )}
            >
                {content}
                {streaming && !isUser && (
                    <span className="ml-1 inline-block h-3 w-[2px] bg-primary align-middle motion-safe:animate-pulse" />
                )}
            </div>
        </div>
    );
}

function ToolBubble({ message }: { message: ChatMessage }) {
    return (
        <div className="flex gap-3 px-1">
            <Avatar role="tool" />
            <div className="max-w-[90%] flex-1 rounded-2xl bg-accent/30 ring-1 ring-border/50 p-3">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-2">
                    <Wrench className="h-3 w-3" />
                    <span>{message.toolName ?? 'tool'}</span>
                </div>
                {message.toolResult ? (
                    <ToolResultCard toolName={message.toolName} result={message.toolResult} />
                ) : (
                    <p className="text-xs text-muted-foreground">No data returned.</p>
                )}
            </div>
        </div>
    );
}

function Avatar({ role }: { role: ChatMessage['role'] }) {
    const base = 'h-8 w-8 shrink-0 rounded-full flex items-center justify-center ring-1';
    if (role === 'user') {
        return (
            <div className={cn(base, 'bg-primary/15 text-primary ring-primary/30')}>
                <User className="h-4 w-4" />
            </div>
        );
    }
    if (role === 'tool') {
        return (
            <div className={cn(base, 'bg-accent/40 text-accent-foreground ring-border/50')}>
                <Wrench className="h-4 w-4" />
            </div>
        );
    }
    return (
        <div className={cn(base, 'bg-gradient-to-br from-primary/20 to-accent/30 text-primary ring-border/50')}>
            <Bot className="h-4 w-4" />
        </div>
    );
}
