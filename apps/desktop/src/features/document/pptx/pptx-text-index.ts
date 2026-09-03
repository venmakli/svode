import type { PptxTextIndex, PptxTextSlide } from "../model/types";

export const PPTX_TEXT_LIMIT = 1_000_000;

export async function extractPptxText(
  presentation: PptxTextSource,
  signal: AbortSignal,
  limit = PPTX_TEXT_LIMIT,
): Promise<PptxTextIndex> {
  const slides: PptxTextSlide[] = [];
  let characters = 0;
  let truncated = false;

  for (
    let slideIndex = 0;
    slideIndex < presentation.slideCount;
    slideIndex += 1
  ) {
    if (signal.aborted || truncated) break;
    const runs = await presentation.collectSlideRuns(slideIndex);
    if (signal.aborted) break;
    const textParts: string[] = [];

    for (const run of runs) {
      const text = run.text.trim();
      if (!text) continue;
      const required = text.length + (textParts.length ? 1 : 0);
      if (required > Math.max(limit - characters, 0)) {
        truncated = true;
        break;
      }
      textParts.push(text);
      characters += required;
    }

    const notes = presentation.getNotes(slideIndex)?.trim() || undefined;
    let acceptedNotes: string | undefined;
    if (!truncated && notes) {
      if (notes.length > Math.max(limit - characters, 0)) {
        truncated = true;
      } else {
        acceptedNotes = notes;
        characters += notes.length;
      }
    }

    slides.push({
      notes: acceptedNotes,
      slideIndex,
      text: textParts.join("\n"),
    });
  }

  return {
    complete:
      !signal.aborted &&
      !truncated &&
      slides.length === presentation.slideCount,
    slides,
    truncated,
  };
}

interface PptxTextSource {
  collectSlideRuns(slideIndex: number): Promise<readonly { text: string }[]>;
  getNotes(slideIndex: number): string | null;
  readonly slideCount: number;
}
