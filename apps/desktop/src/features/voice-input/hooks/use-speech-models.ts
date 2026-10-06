import { useEffect, useState } from "react";
import {
  listenSpeechModelProgress,
  listenSpeechModelsChanged,
  listSpeechModels,
  type SpeechModelsDto,
} from "../api";
import { withProgress } from "../model/models";

/** The release catalog with this device's models, kept current by events. */
export function useSpeechModels(): SpeechModelsDto | null {
  const [models, setModels] = useState<SpeechModelsDto | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      listSpeechModels()
        .then((next) => {
          if (alive) setModels(next);
        })
        .catch(() => undefined);
    };
    load();
    const unlisteners = [
      listenSpeechModelsChanged(load),
      listenSpeechModelProgress((progress) =>
        setModels((current) => current && withProgress(current, progress)),
      ),
    ];
    return () => {
      alive = false;
      for (const unlisten of unlisteners) {
        void unlisten.then((stop) => stop()).catch(() => undefined);
      }
    };
  }, []);
  return models;
}
