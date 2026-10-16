import { useEffect, useRef } from "react";
import { listenDictatedTexts, takeDictatedTexts } from "../api";

/**
 * Text Desktop recognized after this window reloaded during a dictation
 * (`06`, stop from outside): `onText` gets each text once, with the key of
 * the composer it was dictated into, at load or whenever it is ready.
 */
export function useDictatedTexts(onText: (key: string, text: string) => void) {
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  });

  useEffect(() => {
    let alive = true;
    // A taken text is gone from Desktop, so it is delivered even if this
    // effect ended meanwhile.
    const take = () => {
      if (!alive) return;
      takeDictatedTexts()
        .then((texts) => {
          for (const { key, text } of texts) onTextRef.current(key, text);
        })
        .catch(() => undefined);
    };
    // Listen first, so a text ready meanwhile is not missed.
    const unlisten = listenDictatedTexts(take);
    void unlisten.then(take, take);
    return () => {
      alive = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
}
