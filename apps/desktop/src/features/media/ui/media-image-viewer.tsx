import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Expand,
  FileImage,
  FolderOpen,
  Info,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import type { MediaSourceDescriptor, MediaViewState } from "../model/types";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const PAN_STEP = 48;

const transparencyBackground: CSSProperties = {
  backgroundColor: "var(--background)",
  backgroundImage:
    "linear-gradient(45deg,color-mix(in oklab,var(--muted) 70%,transparent) 25%,transparent 25%),linear-gradient(-45deg,color-mix(in oklab,var(--muted) 70%,transparent) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,color-mix(in oklab,var(--muted) 70%,transparent) 75%),linear-gradient(-45deg,transparent 75%,color-mix(in oklab,var(--muted) 70%,transparent) 75%)",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
  backgroundSize: "16px 16px",
};

export function MediaImageViewer({
  externalOpenError,
  loading,
  onOpenExternal,
  onReady,
  onRegisterExternalSuspender,
  onRegisterRendererDisposer,
  onRenderError,
  onViewStateChange,
  source,
  title,
  toolbarActions,
  viewState,
}: {
  externalOpenError: boolean;
  loading: boolean;
  onOpenExternal(): void;
  onReady(dimensions: { width: number; height: number }): void;
  onRegisterExternalSuspender(suspender: () => void): () => void;
  onRegisterRendererDisposer(disposer: () => void): () => void;
  onRenderError(): void;
  onViewStateChange(
    update: MediaViewState | ((current: MediaViewState) => MediaViewState),
  ): void;
  source: MediaSourceDescriptor;
  title: string;
  toolbarActions?: ReactNode;
  viewState: MediaViewState;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const restoredSourceRef = useRef<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const [runtimeDimensions, setRuntimeDimensions] = useState<{
    height: number;
    width: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [gifPlaying, setGifPlaying] = useState(false);
  const [gifUrl, setGifUrl] = useState(
    source.animated ? source.sourceUrl : null,
  );
  const [gifNonce, setGifNonce] = useState(0);
  const dimensions = useMemo(
    () =>
      source.width && source.height
        ? { height: source.height, width: source.width }
        : runtimeDimensions,
    [runtimeDimensions, source.height, source.width],
  );
  const fitScale = dimensions
    ? Math.min(
        1,
        Math.max(MIN_ZOOM, (viewportSize.width - 32) / dimensions.width),
        Math.max(MIN_ZOOM, (viewportSize.height - 32) / dimensions.height),
      )
    : 1;
  const scale = viewState.mode === "fit" ? fitScale : viewState.zoom;
  const renderedWidth = dimensions ? dimensions.width * scale : undefined;
  const renderedHeight = dimensions ? dimensions.height * scale : undefined;
  const maximumZoom = maxSafeZoom(source);
  const canUseActualSize = maximumZoom >= 1;
  const canPan =
    Boolean(renderedWidth && renderedWidth > viewportSize.width - 24) ||
    Boolean(renderedHeight && renderedHeight > viewportSize.height - 24);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () =>
      setViewportSize({
        height: viewport.clientHeight,
        width: viewport.clientWidth,
      });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      !renderedWidth ||
      !renderedHeight ||
      restoredSourceRef.current === source.capabilityToken
    ) {
      return;
    }
    viewport.scrollTo({ left: viewState.panX, top: viewState.panY });
    restoredSourceRef.current = source.capabilityToken;
  }, [
    renderedHeight,
    renderedWidth,
    source.capabilityToken,
    viewState.panX,
    viewState.panY,
  ]);

  const freezeGif = useCallback(() => {
    if (!source.animated) return;
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (
      image?.complete &&
      canvas &&
      image.naturalWidth &&
      image.naturalHeight
    ) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0);
    }
    image?.removeAttribute("src");
    setGifUrl(null);
    setGifPlaying(false);
  }, [source.animated]);

  useEffect(
    () =>
      onRegisterRendererDisposer(() => {
        imageRef.current?.removeAttribute("src");
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }),
    [onRegisterRendererDisposer],
  );

  useEffect(
    () => onRegisterExternalSuspender(freezeGif),
    [freezeGif, onRegisterExternalSuspender],
  );

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) {
      onRenderError();
      return;
    }
    const loadedDimensions = {
      height: image.naturalHeight,
      width: image.naturalWidth,
    };
    setRuntimeDimensions(loadedDimensions);
    onReady(loadedDimensions);
    if (source.animated && !gifPlaying) {
      try {
        freezeGif();
      } catch {
        onRenderError();
      }
    }
  }, [freezeGif, gifPlaying, onReady, onRenderError, source.animated]);

  const setZoom = (zoom: number) => {
    const bounded = Math.min(maximumZoom, Math.max(MIN_ZOOM, zoom));
    onViewStateChange((current) => ({
      ...current,
      mode: "custom",
      zoom: bounded,
    }));
  };
  const setFit = () =>
    onViewStateChange((current) => ({
      ...current,
      mode: "fit",
      panX: 0,
      panY: 0,
    }));
  const playGif = () => {
    const nonce = gifNonce + 1;
    setGifNonce(nonce);
    setGifPlaying(true);
    setGifUrl(`${source.sourceUrl}?play=${nonce}`);
  };
  const replayGif = () => {
    const nonce = gifNonce + 1;
    setGifNonce(nonce);
    setGifPlaying(true);
    setGifUrl(`${source.sourceUrl}?replay=${nonce}`);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(scale * 1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom(scale / 1.25);
    } else if (event.key === "0") {
      event.preventDefault();
      setFit();
    } else if (event.key === "1" && canUseActualSize) {
      event.preventDefault();
      setZoom(1);
    } else if (event.key === " " && source.animated) {
      event.preventDefault();
      if (gifPlaying) freezeGif();
      else playGif();
    } else if (event.key === "ArrowLeft" && canPan) {
      event.preventDefault();
      viewport.scrollBy({ left: -PAN_STEP });
    } else if (event.key === "ArrowRight" && canPan) {
      event.preventDefault();
      viewport.scrollBy({ left: PAN_STEP });
    } else if (event.key === "ArrowUp" && canPan) {
      event.preventDefault();
      viewport.scrollBy({ top: -PAN_STEP });
    } else if (event.key === "ArrowDown" && canPan) {
      event.preventDefault();
      viewport.scrollBy({ top: PAN_STEP });
    }
  };

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !canPan || event.button !== 0) return;
    viewport.focus();
    viewport.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      startX: event.clientX,
      startY: event.clientY,
    };
    setDragging(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    onViewStateChange((current) => ({
      ...current,
      panX: viewport.scrollLeft,
      panY: viewport.scrollTop,
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <MediaImageToolbar
        canUseActualSize={canUseActualSize}
        gifPlaying={gifPlaying}
        onFit={setFit}
        onGifPause={freezeGif}
        onGifPlay={playGif}
        onGifReplay={replayGif}
        onOpenExternal={onOpenExternal}
        onZoomIn={() => setZoom(scale * 1.25)}
        onZoomOut={() => setZoom(scale / 1.25)}
        onZoomOne={() => setZoom(1)}
        scale={scale}
        source={source}
        title={title}
        toolbarActions={toolbarActions}
        viewMode={viewState.mode}
      />
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          canPan && (dragging ? "cursor-grabbing" : "cursor-grab"),
        )}
        style={transparencyBackground}
        tabIndex={0}
        aria-label={m.media_image_viewport()}
        aria-busy={loading}
        onKeyDown={handleKeyDown}
        onPointerCancel={endPan}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onScroll={(event) => {
          if (dragRef.current) return;
          onViewStateChange((current) => ({
            ...current,
            panX: event.currentTarget.scrollLeft,
            panY: event.currentTarget.scrollTop,
          }));
        }}
      >
        <div className="flex min-h-full min-w-full p-4">
          {source.animated ? (
            <>
              <canvas
                ref={canvasRef}
                className={cn("m-auto shrink-0", gifPlaying && "hidden")}
                style={{ height: renderedHeight, width: renderedWidth }}
                aria-hidden={gifPlaying}
                aria-label={title}
                role="img"
              />
              <img
                ref={imageRef}
                alt={gifPlaying ? title : ""}
                aria-hidden={!gifPlaying}
                className={cn("m-auto shrink-0", !gifPlaying && "hidden")}
                crossOrigin="anonymous"
                draggable={false}
                src={gifUrl ?? undefined}
                style={{ height: renderedHeight, width: renderedWidth }}
                onError={onRenderError}
                onLoad={handleImageLoad}
              />
            </>
          ) : (
            <img
              ref={imageRef}
              alt={title}
              className="m-auto shrink-0"
              crossOrigin="anonymous"
              draggable={false}
              src={source.sourceUrl}
              style={{ height: renderedHeight, width: renderedWidth }}
              onError={onRenderError}
              onLoad={handleImageLoad}
            />
          )}
        </div>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Skeleton className="size-16 rounded-xl" />
          </div>
        ) : null}
      </div>
      {externalOpenError ? (
        <p
          className="shrink-0 border-t px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {m.media_external_open_error()}
        </p>
      ) : null}
    </div>
  );
}

function MediaImageToolbar({
  canUseActualSize,
  gifPlaying,
  onFit,
  onGifPause,
  onGifPlay,
  onGifReplay,
  onOpenExternal,
  onZoomIn,
  onZoomOne,
  onZoomOut,
  scale,
  source,
  title,
  toolbarActions,
  viewMode,
}: {
  canUseActualSize: boolean;
  gifPlaying: boolean;
  onFit(): void;
  onGifPause(): void;
  onGifPlay(): void;
  onGifReplay(): void;
  onOpenExternal(): void;
  onZoomIn(): void;
  onZoomOne(): void;
  onZoomOut(): void;
  scale: number;
  source: MediaSourceDescriptor;
  title: string;
  toolbarActions?: ReactNode;
  viewMode: MediaViewState["mode"];
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2">
      <FileImage
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div
        className="min-w-16 flex-1 truncate text-sm font-medium"
        title={title}
      >
        {title}
      </div>
      {source.animated ? (
        <ButtonGroup aria-label={m.media_animation_controls()}>
          <ToolbarButton
            label={gifPlaying ? m.media_pause() : m.media_play()}
            onClick={gifPlaying ? onGifPause : onGifPlay}
          >
            {gifPlaying ? <Pause /> : <Play />}
          </ToolbarButton>
          <ToolbarButton label={m.media_replay()} onClick={onGifReplay}>
            <RefreshCw />
          </ToolbarButton>
        </ButtonGroup>
      ) : null}
      <ButtonGroup aria-label={m.media_zoom_controls()}>
        <ToolbarButton label={m.media_zoom_out()} onClick={onZoomOut}>
          <Minus />
        </ToolbarButton>
        <ButtonGroupText className="min-w-14 justify-center px-2 text-xs tabular-nums">
          {viewMode === "fit" ? m.media_fit() : `${Math.round(scale * 100)}%`}
        </ButtonGroupText>
        <ToolbarButton label={m.media_zoom_in()} onClick={onZoomIn}>
          <Plus />
        </ToolbarButton>
      </ButtonGroup>
      <ButtonGroup aria-label={m.media_size_controls()}>
        <ToolbarButton label={m.media_fit()} onClick={onFit}>
          <Expand />
        </ToolbarButton>
        <ToolbarButton
          disabled={!canUseActualSize}
          label={m.media_actual_size()}
          onClick={onZoomOne}
        >
          <span className="text-[11px] font-semibold">1:1</span>
        </ToolbarButton>
      </ButtonGroup>
      <MetadataPopover source={source} />
      <ToolbarButton label={m.media_open_externally()} onClick={onOpenExternal}>
        <FolderOpen />
      </ToolbarButton>
      {toolbarActions}
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          disabled={disabled}
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MetadataPopover({ source }: { source: MediaSourceDescriptor }) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.media_metadata()}
            >
              <Info />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{m.media_metadata()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>{m.media_metadata()}</PopoverTitle>
        </PopoverHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.media_metadata_format()}</dt>
          <dd className="truncate text-right">{formatName(source.format)}</dd>
          <dt className="text-muted-foreground">
            {m.media_metadata_dimensions()}
          </dt>
          <dd className="text-right">
            {source.width && source.height
              ? `${source.width} × ${source.height}`
              : m.media_metadata_unavailable()}
          </dd>
          <dt className="text-muted-foreground">{m.media_metadata_size()}</dt>
          <dd className="text-right">{formatMediaBytes(source.sizeBytes)}</dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function maxSafeZoom(source: MediaSourceDescriptor) {
  if (!source.intrinsicOversized || !source.width || !source.height) {
    return MAX_ZOOM;
  }
  return Math.max(
    MIN_ZOOM,
    Math.min(
      16_384 / source.width,
      16_384 / source.height,
      Math.sqrt(40_000_000 / (source.width * source.height)),
    ),
  );
}

export function formatMediaBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length,
  );
  const scaled = value / 1024 ** exponent;
  const formatted =
    scaled < 10 && !Number.isInteger(scaled)
      ? scaled.toFixed(1).replace(/\.0$/u, "")
      : String(Math.round(scaled));
  return `${formatted} ${units[exponent - 1]}`;
}

function formatName(format: MediaSourceDescriptor["format"]) {
  return format === "three_gp" ? "3GP" : format.toUpperCase();
}
