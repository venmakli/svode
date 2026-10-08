import { useLayoutEffect, useRef, type CSSProperties } from "react";

const LOGO_SOURCE_SIZE = 490;
const LOGO_SIZE_REM = 3;
const LOGO_FILL = "#ffbf00";
const HORIZONTAL_NEIGHBORS = [1, 0, 3, 2] as const;
const VERTICAL_NEIGHBORS = [3, 2, 1, 0] as const;

type CornerRadii = [number, number, number, number];

interface PetalConfig {
  id: string;
  width: number;
  height: number;
  anchorX: "left" | "right";
  anchorXOffset: number;
  anchorY: "top" | "bottom";
  anchorYOffset: number;
  radii: CornerRadii;
  outerCorner: 0 | 1 | 2 | 3;
}

interface PetalGeometry {
  width: string;
  height: string;
  borderRadius: string;
}

const PETALS: PetalConfig[] = [
  {
    id: "top-left",
    width: 230,
    height: 230,
    anchorX: "right",
    anchorXOffset: 250,
    anchorY: "bottom",
    anchorYOffset: 250,
    radii: [182, 42, 42, 42],
    outerCorner: 0,
  },
  {
    id: "bottom-left",
    width: 210,
    height: 210,
    anchorX: "right",
    anchorXOffset: 250,
    anchorY: "top",
    anchorYOffset: 250,
    radii: [42, 42, 42, 166],
    outerCorner: 3,
  },
  {
    id: "bottom-right",
    width: 240,
    height: 240,
    anchorX: "left",
    anchorXOffset: 250,
    anchorY: "top",
    anchorYOffset: 250,
    radii: [42, 42, 190, 42],
    outerCorner: 2,
  },
  {
    id: "top-right",
    width: 175,
    height: 175,
    anchorX: "left",
    anchorXOffset: 250,
    anchorY: "bottom",
    anchorYOffset: 250,
    radii: [42, 138, 42, 42],
    outerCorner: 1,
  },
];

const PETAL_SIZES = PETALS.map(({ width }) => width);
const MIN_PETAL_SIZE = Math.min(...PETAL_SIZES);
const MAX_PETAL_SIZE = Math.max(...PETAL_SIZES);

/** The animated Svode logo; `size` is its side in rem. */
export function ProjectLoadingLogo({
  size = LOGO_SIZE_REM,
}: {
  size?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative shrink-0"
      style={{ width: `${size}rem`, height: `${size}rem` }}
    >
      {PETALS.map((petal) => (
        <Petal key={petal.id} config={petal} size={size} />
      ))}
    </div>
  );
}

function Petal({ config, size }: { config: PetalConfig; size: number }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const position: CSSProperties = {
    [config.anchorX]: toRem(config.anchorXOffset, size),
    [config.anchorY]: toRem(config.anchorYOffset, size),
  };
  const initialGeometry = petalGeometry(config, 1, size);

  useLayoutEffect(() => {
    const element = elementRef.current;

    // Without Web Animations or with reduced motion the logo stays still.
    if (
      !element ||
      typeof element.animate !== "function" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const duration = 7_200 + Math.random() * 2_800;
    const firstScale = randomScale(config);
    const scales = [
      firstScale,
      randomScale(config),
      randomScale(config),
      randomScale(config),
      randomScale(config),
      randomScale(config),
      firstScale,
    ];
    const keyframes = scales.map((scale) => ({
      ...petalGeometry(config, scale, size),
      easing: "cubic-bezier(0.45, 0, 0.55, 1)",
    }));
    const animation = element.animate(keyframes, {
      duration,
      iterations: Infinity,
      fill: "both",
    });

    animation.currentTime = Math.random() * duration;

    return () => animation.cancel();
  }, [config, size]);

  return (
    <span
      ref={elementRef}
      className="absolute"
      style={{
        ...position,
        backgroundColor: LOGO_FILL,
        ...initialGeometry,
      }}
    />
  );
}

function petalGeometry(
  config: PetalConfig,
  scale: number,
  size: number,
): PetalGeometry {
  const width = config.width * scale;
  const height = config.height * scale;
  const radii = fixedCenterRadii(config, width, height, scale);

  return {
    width: toRem(width, size),
    height: toRem(height, size),
    borderRadius: radii.map((radius) => toRem(radius, size)).join(" "),
  };
}

function fixedCenterRadii(
  config: PetalConfig,
  width: number,
  height: number,
  scale: number,
): CornerRadii {
  const radii = [...config.radii] as CornerRadii;
  const horizontalNeighbor = HORIZONTAL_NEIGHBORS[config.outerCorner];
  const verticalNeighbor = VERTICAL_NEIGHBORS[config.outerCorner];
  const maxOuterRadius =
    Math.min(
      width - radii[horizontalNeighbor],
      height - radii[verticalNeighbor],
    ) - 0.001;

  radii[config.outerCorner] = Math.min(
    config.radii[config.outerCorner] * scale,
    maxOuterRadius,
  );

  return radii;
}

function toRem(value: number, size: number) {
  return `${(value / LOGO_SOURCE_SIZE) * size}rem`;
}

function randomScale(config: PetalConfig) {
  return petalScaleForProgress(config.width, Math.random());
}

export function petalScaleForProgress(baseSize: number, progress: number) {
  const targetSize =
    MIN_PETAL_SIZE + progress * (MAX_PETAL_SIZE - MIN_PETAL_SIZE);

  return targetSize / baseSize;
}
