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

export function ProjectLoadingLogo() {
  return (
    <div aria-hidden="true" className="relative size-12">
      {PETALS.map((petal) => (
        <Petal key={petal.id} config={petal} />
      ))}
    </div>
  );
}

function Petal({ config }: { config: PetalConfig }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const position: CSSProperties = {
    [config.anchorX]: toRem(config.anchorXOffset),
    [config.anchorY]: toRem(config.anchorYOffset),
  };
  const initialGeometry = petalGeometry(config, 1);

  useLayoutEffect(() => {
    const element = elementRef.current;

    if (
      !element ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const duration = 7_200 + Math.random() * 2_800;
    const firstScale = randomScale();
    const scales = [
      firstScale,
      randomScale(),
      randomScale(),
      randomScale(),
      randomScale(),
      randomScale(),
      firstScale,
    ];
    const keyframes = scales.map((scale) => ({
      ...petalGeometry(config, scale),
      easing: "cubic-bezier(0.45, 0, 0.55, 1)",
    }));
    const animation = element.animate(keyframes, {
      duration,
      iterations: Infinity,
      fill: "both",
    });

    animation.currentTime = Math.random() * duration;

    return () => animation.cancel();
  }, [config]);

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

function petalGeometry(config: PetalConfig, scale: number): PetalGeometry {
  const width = config.width * scale;
  const height = config.height * scale;
  const radii = fixedCenterRadii(config, width, height, scale);

  return {
    width: toRem(width),
    height: toRem(height),
    borderRadius: radii.map(toRem).join(" "),
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

function toRem(value: number) {
  return `${(value / LOGO_SOURCE_SIZE) * LOGO_SIZE_REM}rem`;
}

function randomScale() {
  return 0.88 + Math.random() * 0.24;
}
