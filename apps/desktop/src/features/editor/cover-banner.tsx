import { useMemo, useRef, useState, type PointerEvent } from "react";
import { convertFileSrc, invokeCommand as invoke } from "@/platform/native/invoke";
import { ImagePlus, MoveVertical, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { joinAbs } from "@/features/editor/doc-link-utils";
import { cn } from "@/shared/lib/utils";
import { pickMediaFiles } from "@/platform/filesystem/native-file-picker";
import type { CoverColorName, EntryCover } from "./types";
import * as m from "@/paraglide/messages.js";

const COVER_COLORS: { name: CoverColorName; label: string }[] = [
  { name: "neutral", label: "Neutral" },
  { name: "gray", label: "Gray" },
  { name: "red", label: "Red" },
  { name: "orange", label: "Orange" },
  { name: "yellow", label: "Yellow" },
  { name: "green", label: "Green" },
  { name: "blue", label: "Blue" },
  { name: "purple", label: "Purple" },
  { name: "pink", label: "Pink" },
  { name: "brown", label: "Brown" },
];

const COVER_GRADIENTS: Record<CoverColorName, string> = {
  neutral:
    "linear-gradient(135deg, oklch(0.94 0.02 255), oklch(0.88 0.03 255))",
  gray: "linear-gradient(135deg, oklch(0.93 0.02 250), oklch(0.84 0.03 250))",
  red: "linear-gradient(135deg, oklch(0.9 0.12 25), oklch(0.78 0.16 25))",
  orange: "linear-gradient(135deg, oklch(0.92 0.12 60), oklch(0.84 0.16 40))",
  yellow: "linear-gradient(135deg, oklch(0.93 0.12 95), oklch(0.86 0.16 85))",
  green: "linear-gradient(135deg, oklch(0.92 0.12 145), oklch(0.82 0.18 165))",
  blue: "linear-gradient(135deg, oklch(0.88 0.14 250), oklch(0.78 0.18 270))",
  purple: "linear-gradient(135deg, oklch(0.88 0.14 295), oklch(0.82 0.16 320))",
  pink: "linear-gradient(135deg, oklch(0.9 0.13 340), oklch(0.82 0.16 350))",
  brown: "linear-gradient(135deg, oklch(0.88 0.07 70), oklch(0.76 0.09 60))",
};

interface UploadResponse {
  spaceId: string | null;
  relPath: string;
  fileName: string;
  sizeBytes: number;
  mime: string;
}

interface CoverBannerProps {
  cover: EntryCover | null;
  projectPath: string | null;
  spacePath: string;
  documentPath: string | null;
  onCoverChange: (cover: EntryCover | null) => void;
  size?: "default" | "compact";
}

function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function colorStyle(name: CoverColorName) {
  return { background: COVER_GRADIENTS[name] };
}

export function CoverBanner({
  cover,
  projectPath,
  spacePath,
  documentPath,
  onCoverChange,
  size = "default",
}: CoverBannerProps) {
  const bannerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ y: number; position: number } | null>(null);
  const [isRepositioning, setIsRepositioning] = useState(false);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);

  const imageSrc = useMemo(() => {
    if (!cover || cover.type !== "image" || !spacePath) return undefined;
    return convertFileSrc(joinAbs(spacePath, cover.path));
  }, [cover, spacePath]);

  const imagePosition =
    cover?.type === "image" ? (draftPosition ?? cover.position ?? 50) : 50;

  async function uploadImageCover() {
    if (!projectPath || !spacePath || !documentPath) {
      toast.error(m.toast_error());
      return;
    }

    const files = await pickMediaFiles("image", false);
    const file = files[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const documentAbsPath = documentPath.startsWith("/")
        ? documentPath
        : joinAbs(spacePath, documentPath);
      const result = await invoke<UploadResponse>("upload_asset", {
        projectPath,
        documentAbsPath,
        fileName: file.name,
        bytes,
        documentId: documentPath,
      });
      onCoverChange({
        type: "image",
        path: result.relPath,
        position: 50,
      });
    } catch (err) {
      console.error("Failed to upload cover image:", err);
      toast.error(m.toast_error());
    }
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!isRepositioning || cover?.type !== "image") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      y: e.clientY,
      position: cover.position ?? 50,
    };
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    const box = bannerRef.current?.getBoundingClientRect();
    if (!start || !box || box.height === 0) return;
    const delta = ((e.clientY - start.y) / box.height) * 100;
    setDraftPosition(clampPosition(start.position + delta));
  }

  function handlePointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current || cover?.type !== "image") return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragStartRef.current = null;
    const nextPosition = draftPosition ?? cover.position ?? 50;
    setDraftPosition(null);
    setIsRepositioning(false);
    onCoverChange({ ...cover, position: nextPosition });
  }

  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={cover ? "secondary" : "ghost"}
          size="sm"
          className={cn(!cover && "h-10 w-full justify-center")}
        >
          <ImagePlus data-icon="inline-start" />
          {cover ? m.editor_change_cover() : m.editor_add_cover()}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="uppercase tracking-wide text-muted-foreground">
          {m.editor_cover_colors()}
        </DropdownMenuLabel>
        <DropdownMenuGroup className="grid grid-cols-5 gap-1 p-1">
          {COVER_COLORS.map((color) => {
            const isActive =
              cover?.type === "color" && cover.value === color.name;

            return (
              <DropdownMenuItem
                key={color.name}
                aria-label={color.label}
                className="size-8 justify-center p-1"
                onSelect={() =>
                  onCoverChange({ type: "color", value: color.name })
                }
              >
                <span
                  className={cn(
                    "size-5 rounded-full ring-1 ring-foreground/10",
                    isActive &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                  )}
                  style={colorStyle(color.name)}
                />
                <span className="sr-only">{color.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void uploadImageCover()}>
          <Upload data-icon="inline-start" />
          {m.editor_upload_cover_image()}
        </DropdownMenuItem>
        {cover && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onCoverChange(null)}
            >
              <Trash2 data-icon="inline-start" />
              {m.editor_remove_cover()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!cover) {
    return (
      <div className="group h-12">
        <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {picker}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={bannerRef}
      className={cn(
        "group relative mb-6 overflow-hidden rounded-md",
        size === "compact"
          ? "h-44 min-h-32 max-h-48"
          : "h-[30vh] min-h-40 max-h-72",
        isRepositioning && "cursor-move",
      )}
      style={cover.type === "color" ? colorStyle(cover.value) : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {cover.type === "image" && imageSrc && (
        <img
          alt=""
          src={imageSrc}
          className="size-full object-cover"
          draggable={false}
          style={{ objectPosition: `center ${imagePosition}%` }}
        />
      )}
      <div className="absolute right-3 top-3 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {picker}
        {cover.type === "image" && (
          <Button
            type="button"
            variant={isRepositioning ? "default" : "secondary"}
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setIsRepositioning((current) => !current);
            }}
          >
            <MoveVertical data-icon="inline-start" />
            {m.editor_reposition_cover()}
          </Button>
        )}
      </div>
    </div>
  );
}
