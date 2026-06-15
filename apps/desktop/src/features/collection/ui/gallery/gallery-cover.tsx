import { useEffect, useRef, useState, type RefObject } from "react";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { cn } from "@/shared/lib/utils";
import type { Entry } from "@/features/entry";
import type { CollectionSchema } from "@/features/properties/model";
import { coverStyle, galleryCoverRatio, resolveGalleryCover } from "./utils";

export function GalleryCover({
  entry,
  cardCover,
  coverFit,
  coverAspect,
  schema,
  spacePath,
}: {
  entry: Entry;
  cardCover: string[];
  coverFit: "cover" | "contain";
  coverAspect: string;
  schema: CollectionSchema;
  spacePath: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = useLazyVisible(ref);
  const cover = resolveGalleryCover({ entry, cardCover, schema, spacePath });

  if (!cover) return null;

  return (
    <AspectRatio
      ref={ref}
      ratio={galleryCoverRatio(coverAspect)}
      className={cn(
        "relative flex items-center justify-center overflow-hidden",
        cover.kind === "image" && coverFit === "contain" && "p-3",
      )}
      style={coverStyle(cover)}
    >
      {cover.kind === "image" && visible ? (
        <img
          alt=""
          src={cover.src}
          loading="lazy"
          draggable={false}
          className={cn(
            "absolute inset-0 size-full",
            coverFit === "contain" ? "object-contain p-3" : "object-cover",
          )}
          style={{ objectPosition: `center ${cover.position}%` }}
        />
      ) : null}
      {cover.kind === "icon" ? (
        <span className="relative text-5xl drop-shadow-sm">{cover.value}</span>
      ) : null}
      {cover.kind === "initial" ? (
        <span className="relative text-4xl font-bold text-foreground/50">
          {cover.value}
        </span>
      ) : null}
    </AspectRatio>
  );
}

function useLazyVisible(ref: RefObject<Element | null>) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, visible]);

  return visible;
}
