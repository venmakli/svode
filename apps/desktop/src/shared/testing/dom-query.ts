import { act } from "react";

/** The first button of `root` whose text starts with `text`. */
export function buttonByText(root: ParentNode, text: string) {
  const button = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim().startsWith(text));
  if (!button) throw new Error(`No button "${text}"`);
  return button;
}

/** Clicks an element and lets the effects of the click settle. */
export async function clickElement(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Types into a controlled input as a user does. */
export async function typeIntoInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(
      new input.ownerDocument.defaultView!.Event("input", {
        bubbles: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
