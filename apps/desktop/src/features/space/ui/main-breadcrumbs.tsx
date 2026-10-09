import { Fragment, type ReactNode } from "react";
import {
  ChevronDown,
  Database,
  FileImage,
  FileText,
  FolderOpen,
  Music,
  PanelsTopLeft,
  Video,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import {
  useBreadcrumbNavigation,
  useMainBreadcrumbs,
  useSpaceBreadcrumbPrefix,
  type BreadcrumbNavigationProps,
} from "../hooks/use-main-breadcrumbs";
import {
  collapseBreadcrumbs,
  type BreadcrumbFallbackIcon,
  type MainBreadcrumb,
  type MainBreadcrumbTarget,
} from "../lib/space-breadcrumbs";
import type { SpaceInfo } from "../model/types";

interface BreadcrumbsProps extends BreadcrumbNavigationProps {
  /** Home starts the chain with the project; inside a project it is not shown. */
  home: boolean;
}

/** The breadcrumbs of the object the main area shows. */
export function MainBreadcrumbs({ home, ...navigation }: BreadcrumbsProps) {
  const { crumbs, prefixLength, spaceChoices } = useMainBreadcrumbs(home);
  if (crumbs.length === 0) return null;
  return (
    <BreadcrumbTrail
      crumbs={crumbs}
      prefixLength={prefixLength}
      spaceChoices={spaceChoices}
      navigation={navigation}
    />
  );
}

/**
 * The project and Space prefix of an object of the Space at `spacePath`,
 * followed by `current`, the object itself.
 */
export function SpaceBreadcrumbs({
  home,
  spacePath,
  current,
  ...navigation
}: BreadcrumbsProps & { spacePath: string; current: ReactNode }) {
  const { crumbs, spaceChoices } = useSpaceBreadcrumbPrefix(home, spacePath);
  return (
    <BreadcrumbTrail
      crumbs={crumbs}
      prefixLength={crumbs.length}
      spaceChoices={spaceChoices}
      navigation={navigation}
      current={current}
    />
  );
}

function BreadcrumbTrail({
  crumbs,
  prefixLength,
  spaceChoices,
  navigation,
  current,
}: {
  crumbs: MainBreadcrumb[];
  prefixLength: number;
  spaceChoices: SpaceInfo[];
  navigation: BreadcrumbNavigationProps;
  current?: ReactNode;
}) {
  const open = useBreadcrumbNavigation(navigation);
  const items = collapseBreadcrumbs(crumbs, prefixLength);
  const lastIndex = current ? -1 : items.length - 1;

  return (
    <div className="min-w-0 flex-1 px-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm">
          {items.map((item, index) => (
            <Fragment key={item.kind === "crumb" ? item.crumb.key : "ellipsis"}>
              {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
              {item.kind === "ellipsis" ? (
                <BreadcrumbItem className="shrink-0">
                  <HiddenCrumbsMenu hidden={item.hidden} onOpen={open} />
                </BreadcrumbItem>
              ) : index === lastIndex ? (
                <BreadcrumbItem className="min-w-0">
                  <CurrentCrumb
                    crumb={item.crumb}
                    spaceChoices={spaceChoices}
                    onOpen={open}
                  />
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem className="min-w-5 shrink-[100]">
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      className={crumbClassName}
                      onClick={() => void open(item.crumb.target)}
                    >
                      <CrumbLabel crumb={item.crumb} />
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              )}
            </Fragment>
          ))}
          {current && (
            <>
              {items.length > 0 && <BreadcrumbSeparator className="shrink-0" />}
              <BreadcrumbItem className="min-w-0">{current}</BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}

const crumbClassName =
  "flex min-w-0 max-w-[220px] items-center gap-1.5 text-left";

function CrumbLabel({ crumb }: { crumb: MainBreadcrumb }) {
  return (
    <>
      <CrumbIcon icon={crumb.icon} fallback={crumb.fallback} />
      <span className="truncate">{crumb.label}</span>
    </>
  );
}

/**
 * The open object; the element of a Space whose home is open switches
 * between the Spaces of a project with two and more.
 */
function CurrentCrumb({
  crumb,
  spaceChoices,
  onOpen,
}: {
  crumb: MainBreadcrumb;
  spaceChoices: SpaceInfo[];
  onOpen: (target: MainBreadcrumbTarget) => Promise<void>;
}) {
  if (crumb.target.kind !== "space-home" || spaceChoices.length === 0) {
    return (
      <BreadcrumbPage className={crumbClassName}>
        <CrumbLabel crumb={crumb} />
      </BreadcrumbPage>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          crumbClassName,
          "text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        )}
      >
        <CrumbLabel crumb={crumb} />
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {spaceChoices.map((space) => (
          <DropdownMenuItem
            key={space.id}
            onSelect={() =>
              void onOpen({ kind: "space-home", spaceId: space.id })
            }
          >
            <CrumbIcon icon={space.icon || null} fallback="space" />
            {space.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HiddenCrumbsMenu({
  hidden,
  onOpen,
}: {
  hidden: MainBreadcrumb[];
  onOpen: (target: MainBreadcrumbTarget) => Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={m.space_breadcrumb_hidden_path()}
        className="flex items-center gap-1 transition-colors hover:text-foreground"
      >
        <BreadcrumbEllipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {hidden.map((crumb) => (
          <DropdownMenuItem
            key={crumb.key}
            onSelect={() => void onOpen(crumb.target)}
          >
            <CrumbIcon icon={crumb.icon} fallback={crumb.fallback} />
            {crumb.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const fallbackIcons = {
  page: FileText,
  collection: Database,
  app: PanelsTopLeft,
  directory: FolderOpen,
  document: FileText,
  image: FileImage,
  audio: Music,
  video: Video,
} as const;

function CrumbIcon({
  icon,
  fallback,
}: {
  icon: string | null;
  fallback: BreadcrumbFallbackIcon;
}) {
  const own = icon?.trim();
  if (own || fallback === "project" || fallback === "space") {
    return (
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center leading-none"
        aria-hidden
      >
        {own || (fallback === "project" ? "\u{1F4C1}" : "\u{1F4C2}")}
      </span>
    );
  }
  const Fallback = fallbackIcons[fallback];
  return (
    <Fallback className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  );
}
