import { useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface RemoteNewsImageProps {
  src: string;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
}

function sanitizeRemoteImageUrl(raw: string): string | null {
  const value = (raw || "").trim();
  if (!value) return null;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return `https://${value.slice(7)}`;
  if (value.startsWith("https://")) return value;
  return null;
}

export function RemoteNewsImage({ src, alt = "", className, fallbackClassName }: RemoteNewsImageProps) {
  // Track which URL failed (rather than a bare boolean) so the failed state
  // resets automatically when `src` changes to a different image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeSrc = useMemo(() => sanitizeRemoteImageUrl(src), [src]);
  const failed = failedSrc !== null && failedSrc === safeSrc;

  if (!safeSrc || failed) {
    return (
      <div
        className={cn(
          "h-16 w-24 rounded-md shrink-0 bg-muted border border-border/50 flex items-center justify-center",
          fallbackClassName,
          className
        )}
        aria-hidden="true"
      >
        <ImageOff className="h-4 w-4 text-muted-foreground/60" />
      </div>
    );
  }

  return (
    <img
      src={safeSrc}
      alt={alt}
      width={96}
      height={64}
      className={cn("h-16 w-24 rounded-md object-cover shrink-0 bg-muted", className)}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(safeSrc)}
    />
  );
}
