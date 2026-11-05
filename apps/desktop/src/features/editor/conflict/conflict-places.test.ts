import { expect, test } from "bun:test";

const { createPlateEditor } = await import("platejs/react");
const { EditorKit } = await import("../plate/editor-kit");
const { fencedCodeRanges } = await import("../model/markdown-io");
const { DEFAULT_CONFLICT_MARKER_SIZE } = await import("./conflict-markers");
const { findConflictPlaces } = await import("./conflict-places");

const editor = createPlateEditor({ plugins: EditorKit });

const lines = (...text: string[]) => text.map((line) => `${line}\n`).join("");
const crlf = (source: string) => source.replaceAll("\n", "\r\n");

/** The places of `body` and the document text around them. */
function places(body: string, bases: (string | null)[] = []) {
  const found = findConflictPlaces(
    body,
    DEFAULT_CONFLICT_MARKER_SIZE,
    bases,
    (markdown) => fencedCodeRanges(editor, markdown),
  );
  const outside: string[] = [];
  let cursor = 0;
  for (const place of found) {
    outside.push(body.slice(cursor, place.start));
    cursor = place.end;
  }
  outside.push(body.slice(cursor));
  return {
    outside,
    places: found.map((place) =>
      place.ambiguous
        ? { lines: place.ambiguous.lines.map(({ text }) => text) }
        : { ours: place.ours, theirs: place.theirs, base: place.base },
    ),
  };
}

// Conflict files written by `git merge-file` 2.55.0 in the `merge` and
// `diff3` styles, labels `HEAD`, `base` and `other`.
const fixtures = {
  // A block inside a fenced code block.
  inCode: {
    merge: lines(
      "# T",
      "",
      "```js",
      "line1",
      "<<<<<<< HEAD",
      "line2a",
      "=======",
      "line2b",
      ">>>>>>> other",
      "line3",
      "```",
      "",
      "End",
    ),
    diff3: lines(
      "# T",
      "",
      "```js",
      "line1",
      "<<<<<<< HEAD",
      "line2a",
      "||||||| base",
      "line2",
      "=======",
      "line2b",
      ">>>>>>> other",
      "line3",
      "```",
      "",
      "End",
    ),
  },
  // A block on the opening fence: ```js against ```ts.
  fence: {
    merge: lines(
      "# T",
      "",
      "<<<<<<< HEAD",
      "```js",
      "=======",
      "```ts",
      ">>>>>>> other",
      "x()",
      "```",
      "",
      "End",
    ),
    diff3: lines(
      "# T",
      "",
      "<<<<<<< HEAD",
      "```js",
      "||||||| base",
      "```",
      "=======",
      "```ts",
      ">>>>>>> other",
      "x()",
      "```",
      "",
      "End",
    ),
  },
  // A code block opened before the block, closed in ours and left open in theirs.
  closedInSide: {
    merge: lines(
      "# T",
      "",
      "```text",
      "a",
      "<<<<<<< HEAD",
      "b mine",
      "```",
      "",
      "End",
      "=======",
      "b theirs",
      "c",
      ">>>>>>> other",
    ),
    diff3: lines(
      "# T",
      "",
      "```text",
      "a",
      "<<<<<<< HEAD",
      "b mine",
      "```",
      "",
      "End",
      "||||||| base",
      "b",
      "```",
      "",
      "End",
      "=======",
      "b theirs",
      "c",
      ">>>>>>> other",
    ),
  },
  // Two blocks in one code block.
  twoInCode: {
    merge: lines(
      "# T",
      "",
      "```js",
      "<<<<<<< HEAD",
      "a1",
      "=======",
      "a2",
      ">>>>>>> other",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "<<<<<<< HEAD",
      "b1",
      "=======",
      "b2",
      ">>>>>>> other",
      "```",
      "",
      "End",
    ),
    diff3: lines(
      "# T",
      "",
      "```js",
      "<<<<<<< HEAD",
      "a1",
      "||||||| base",
      "a0",
      "=======",
      "a2",
      ">>>>>>> other",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "<<<<<<< HEAD",
      "b1",
      "||||||| base",
      "b0",
      "=======",
      "b2",
      ">>>>>>> other",
      "```",
      "",
      "End",
    ),
  },
  // A code block without a closing fence.
  unclosed: {
    merge: lines(
      "# T",
      "",
      "Intro",
      "",
      "```js",
      "<<<<<<< HEAD",
      "x mine",
      "=======",
      "x theirs",
      ">>>>>>> other",
    ),
    diff3: lines(
      "# T",
      "",
      "Intro",
      "",
      "```js",
      "<<<<<<< HEAD",
      "x mine",
      "||||||| base",
      "x",
      "=======",
      "x theirs",
      ">>>>>>> other",
    ),
  },
};

test("a block inside a fenced code block makes a place of the whole code block", () => {
  for (const style of ["merge", "diff3"] as const) {
    // The base of the place is the base of its block among its lines.
    const base = style === "diff3" ? "line2" : null;
    expect(places(fixtures.inCode[style], [base])).toEqual({
      outside: ["# T\n\n", "\nEnd\n"],
      places: [
        {
          ours: "```js\nline1\nline2a\nline3\n```",
          theirs: "```js\nline1\nline2b\nline3\n```",
          base: base && "```js\nline1\nline2\nline3\n```",
        },
      ],
    });
  }
  // An empty base leaves no line.
  expect(places(fixtures.inCode.diff3, [""]).places[0].base).toBe(
    "```js\nline1\nline3\n```",
  );
});

test("a block on the opening fence takes in the code block it opens", () => {
  for (const style of ["merge", "diff3"] as const)
    expect(places(fixtures.fence[style], ["```"])).toEqual({
      outside: ["# T\n\n", "\nEnd\n"],
      places: [
        {
          ours: "```js\nx()\n```",
          theirs: "```ts\nx()\n```",
          base: "```\nx()\n```",
        },
      ],
    });
});

test("a code block opened before the block and closed in one side runs to its end in the other", () => {
  for (const style of ["merge", "diff3"] as const)
    expect(places(fixtures.closedInSide[style])).toEqual({
      outside: ["# T\n\n", ""],
      places: [
        {
          ours: "```text\na\nb mine\n```\n\nEnd",
          theirs: "```text\na\nb theirs\nc",
          base: null,
        },
      ],
    });
});

test("two blocks in one code block are one place, with a base only when both have one", () => {
  for (const style of ["merge", "diff3"] as const) {
    const { outside, places: found } = places(fixtures.twoInCode[style], [
      "a0",
      "b0",
    ]);
    expect(outside).toEqual(["# T\n\n", "\nEnd\n"]);
    expect(found).toEqual([
      {
        ours: "```js\na1\nm1\nm2\nm3\nm4\nm5\nb1\n```",
        theirs: "```js\na2\nm1\nm2\nm3\nm4\nm5\nb2\n```",
        base: "```js\na0\nm1\nm2\nm3\nm4\nm5\nb0\n```",
      },
    ]);
    expect(places(fixtures.twoInCode[style], ["a0", null]).places).toEqual([
      { ...found[0], base: null },
    ]);
    expect(places(fixtures.twoInCode[style]).places).toEqual([
      { ...found[0], base: null },
    ]);
  }
});

test("a code block without a closing fence takes the place to the end of the file", () => {
  for (const style of ["merge", "diff3"] as const)
    expect(places(fixtures.unclosed[style], ["x"])).toEqual({
      outside: ["# T\n\nIntro\n\n", ""],
      places: [
        {
          ours: "```js\nx mine",
          theirs: "```js\nx theirs",
          base: "```js\nx",
        },
      ],
    });
});

test("CRLF files give the places of LF files with their line endings", () => {
  for (const styles of Object.values(fixtures))
    for (const source of Object.values(styles)) {
      const lf = places(source, ["base"]);
      const found = places(crlf(source), ["base"]);
      expect(found.outside).toEqual(lf.outside.map(crlf));
      expect(found.places).toEqual(
        lf.places.map((place) =>
          "lines" in place
            ? place
            : {
                ours: crlf(place.ours),
                theirs: crlf(place.theirs),
                base: place.base === null ? null : crlf(place.base),
              },
        ),
      );
    }
});

// The Pages of the DF-303 report, as `git merge-file` writes them.
const report = {
  // Mine replaces the line with a code block holding `=======`.
  code: lines(
    "# Код",
    "",
    "<<<<<<< HEAD",
    "Пример маркеров:",
    "",
    "```text",
    "=======",
    "```",
    "=======",
    "Строка спора в версии B.",
    ">>>>>>> other",
    "",
    "Конец",
  ),
  // A code block of the common version holds `<<<<<<< HEAD`.
  sheet: {
    merge: lines(
      "# Шпаргалка",
      "",
      "```text",
      "<<<<<<< HEAD",
      "```",
      "",
      "<<<<<<< HEAD",
      "Спорный абзац A.",
      "=======",
      "Спорный абзац B.",
      ">>>>>>> other",
      "",
      "Конец",
    ),
    diff3: lines(
      "# Шпаргалка",
      "",
      "```text",
      "<<<<<<< HEAD",
      "```",
      "",
      "<<<<<<< HEAD",
      "Спорный абзац A.",
      "||||||| base",
      "Спорный абзац.",
      "=======",
      "Спорный абзац B.",
      ">>>>>>> other",
      "",
      "Конец",
    ),
  },
  // A setext underline in mine, no code.
  markers: lines(
    "# Маркеры",
    "",
    "<<<<<<< HEAD",
    "Заголовок",
    "=======",
    "=======",
    "Строка B.",
    ">>>>>>> other",
    "",
    "Конец",
  ),
  // A code block with `=======` outside the block.
  help: {
    merge: lines(
      "# Справка",
      "",
      "```text",
      "=======",
      "```",
      "",
      "<<<<<<< HEAD",
      "Моё.",
      "=======",
      "Входящее.",
      ">>>>>>> other",
      "",
      "Конец",
    ),
    diff3: lines(
      "# Справка",
      "",
      "```text",
      "=======",
      "```",
      "",
      "<<<<<<< HEAD",
      "Моё.",
      "||||||| base",
      "Строка.",
      "=======",
      "Входящее.",
      ">>>>>>> other",
      "",
      "Конец",
    ),
  },
};

test("the ambiguous Pages of the report show the lines of their places", () => {
  expect(places(report.code)).toEqual({
    outside: ["# Код\n\n", "\nКонец\n"],
    places: [
      {
        lines: [
          "<<<<<<< HEAD",
          "Пример маркеров:",
          "",
          "```text",
          "=======",
          "```",
          "=======",
          "Строка спора в версии B.",
          ">>>>>>> other",
        ],
      },
    ],
  });
  // The code block of the common version stays whole in the place.
  for (const style of ["merge", "diff3"] as const)
    expect(places(report.sheet[style])).toEqual({
      outside: ["# Шпаргалка\n\n", "\nКонец\n"],
      places: [
        {
          lines: report.sheet[style]
            .split("\n")
            .slice(2, style === "merge" ? 11 : 13),
        },
      ],
    });
  expect(places(report.markers)).toEqual({
    outside: ["# Маркеры\n\n", "\nКонец\n"],
    places: [
      {
        lines: [
          "<<<<<<< HEAD",
          "Заголовок",
          "=======",
          "=======",
          "Строка B.",
          ">>>>>>> other",
        ],
      },
    ],
  });
});

test("a code block outside a block leaves its place as the block", () => {
  for (const style of ["merge", "diff3"] as const)
    expect(places(report.help[style], ["Строка."])).toEqual({
      outside: ["# Справка\n\n```text\n=======\n```\n\n", "\nКонец\n"],
      places: [{ ours: "Моё.", theirs: "Входящее.", base: "Строка." }],
    });
});

test("Edit of an ambiguous place leaves out only its outer marker lines that are the only ones", async () => {
  const { findConflictPlaces: find } = await import("./conflict-places");
  const [sheet] = find(
    report.sheet.merge,
    DEFAULT_CONFLICT_MARKER_SIZE,
    [],
    (markdown) => fencedCodeRanges(editor, markdown),
  );
  // Two `<` lines: both stay; the only `>` line after the separator does not.
  expect(sheet.ambiguous?.edit).toEqual([
    { text: "```text", marker: false },
    { text: "<<<<<<< HEAD", marker: true },
    { text: "```\n", marker: false },
    { text: "<<<<<<< HEAD", marker: true },
    { text: "Спорный абзац A.", marker: false },
    { text: "=======", marker: true },
    { text: "Спорный абзац B.", marker: false },
  ]);
  const [code] = find(
    report.code,
    DEFAULT_CONFLICT_MARKER_SIZE,
    [],
    (markdown) => fencedCodeRanges(editor, markdown),
  );
  expect(code.ambiguous?.edit).toEqual([
    { text: "Пример маркеров:\n\n```text", marker: false },
    { text: "=======", marker: true },
    { text: "```", marker: false },
    { text: "=======", marker: true },
    { text: "Строка спора в версии B.", marker: false },
  ]);
});
