import type { CSSProperties } from 'react';

const LOSS_PREVIEW_TOKEN = {
    colorblind: '--loss-colorblind',
    classic: '--destructive',
} as const;

export type GainLossPreview = keyof typeof LOSS_PREVIEW_TOKEN;

export function gainLossPreviewStyle(preview: GainLossPreview): CSSProperties {
    return { backgroundColor: `hsl(var(${LOSS_PREVIEW_TOKEN[preview]}))` };
}
