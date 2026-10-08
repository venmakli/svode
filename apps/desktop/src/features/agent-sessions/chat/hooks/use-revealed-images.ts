import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface RevealedImages {
  urls: ReadonlySet<string>;
  reveal: (url: string) => void;
}

const RevealedImagesContext = createContext<RevealedImages | null>(null);

const NONE: ReadonlySet<string> = new Set();

/**
 * External images the user chose to show (`08` R3), for as long as the
 * timeline of `owner` stays open: a message that mounts again shows them,
 * another session and a reopened one do not. Nothing is remembered.
 */
export function RevealedImagesProvider({
  owner,
  children,
}: {
  owner: string;
  children: ReactNode;
}) {
  const [state, setState] = useState({ owner, urls: NONE });
  const urls = state.owner === owner ? state.urls : NONE;
  const value = useMemo<RevealedImages>(
    () => ({
      urls,
      reveal: (url) =>
        setState((current) => ({
          owner,
          urls: new Set(current.owner === owner ? current.urls : NONE).add(url),
        })),
    }),
    [owner, urls],
  );
  return createElement(RevealedImagesContext.Provider, { value }, children);
}

/** Whether an external image is shown, and how to show it. */
export function useRevealedImage(url: string): [boolean, () => void] {
  const shared = useContext(RevealedImagesContext);
  const [local, setLocal] = useState(false);
  if (!shared) return [local, () => setLocal(true)];
  return [shared.urls.has(url), () => shared.reveal(url)];
}
