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
  const [failed, setFailed] = useState(false);
  const safeSrc = useMemo(() => sanitizeRemoteImageUrl(src), [src]);

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
      onError={() => setFailed(true)}
    />
  );
}
