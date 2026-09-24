import { useCallback, useEffect, useRef, useState } from "react";

// A navigation request that shows one owner's block; `request` changes with
// every navigation, so repeating the same destination reveals it again.
export interface SettingsOwnerReveal {
  owner: string | null;
  request: object;
}

// Owner blocks of one project settings page. A block opened once keeps its
// forms loaded while collapsed, so collapsing never drops a pending write.
// A navigation request for an owner expands its block, scrolls it into view
// and focuses its heading.
export function useSettingsOwnerBlocks({
  owner: target,
  request,
}: SettingsOwnerReveal) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(target ? [target] : []),
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(target ? [target] : []),
  );
  // A new request opens its owner's block in the same render.
  const [shownRequest, setShownRequest] = useState(request);
  if (shownRequest !== request) {
    setShownRequest(request);
    if (target) {
      setExpanded(withOwner(expanded, target, true));
      setOpened(withOwner(opened, target, true));
    }
  }
  const headings = useRef(new Map<string, HTMLElement>());
  const headingRefs = useRef(
    new Map<string, (node: HTMLElement | null) => void>(),
  );
  const pending = useRef<string | null>(null);

  const flush = useCallback(() => {
    const owner = pending.current;
    const heading = owner === null ? undefined : headings.current.get(owner);
    if (!heading) return;
    pending.current = null;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, []);

  const setOwnerExpanded = useCallback((owner: string, open: boolean) => {
    setExpanded((current) => withOwner(current, owner, open));
    if (open) setOpened((current) => withOwner(current, owner, true));
  }, []);

  const reveal = useCallback(
    (owner: string) => {
      pending.current = owner;
      setOwnerExpanded(owner, true);
      flush();
    },
    [flush, setOwnerExpanded],
  );

  useEffect(() => {
    pending.current = target;
    flush();
  }, [request, target, flush]);

  // An owner whose block renders after the request is revealed on the first
  // render that contains it.
  useEffect(flush);

  const headingRef = useCallback((owner: string) => {
    let ref = headingRefs.current.get(owner);
    if (!ref) {
      ref = (node) => {
        if (node) headings.current.set(owner, node);
        else headings.current.delete(owner);
      };
      headingRefs.current.set(owner, ref);
    }
    return ref;
  }, []);

  return {
    expanded: (owner: string) => expanded.has(owner),
    opened: (owner: string) => opened.has(owner),
    setExpanded: setOwnerExpanded,
    reveal,
    headingRef,
  };
}

function withOwner(
  owners: ReadonlySet<string>,
  owner: string,
  include: boolean,
) {
  if (owners.has(owner) === include) return owners;
  const next = new Set(owners);
  if (include) next.add(owner);
  else next.delete(owner);
  return next;
}
