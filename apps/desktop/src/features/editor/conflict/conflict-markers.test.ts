import { expect, test } from "bun:test";

import {
  DEFAULT_CONFLICT_MARKER_SIZE,
  findConflictBlocks,
  hasConflictMarkerCandidate,
} from "./conflict-markers";

type Style = "merge" | "diff3" | "zdiff3";

// Conflict files written by Git 2.55.0 for the same merge under each
// `merge.conflictStyle`; base labels are shortened to `base`.
const fixtures: Record<string, Record<Style, string>> = {
  // A line ending in `=======` inside "ours".
  xEquals: {
    merge:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\nx=======\nformula a=======b\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\nx=======\nformula a=======b\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\nx=======\nformula a=======b\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
  },
  // A setext underline of 10 `=` inside "ours".
  setext10: {
    merge:
      "# T\n\n<<<<<<< HEAD\nHeading\n==========\n\nlocal\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<<<<<< HEAD\nHeading\n==========\n\nlocal\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<<<<<< HEAD\nHeading\n==========\n\nlocal\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
  },
  // A setext underline of exactly 7 `=` inside "ours".
  setext7: {
    merge:
      "# T\n\n<<<<<<< HEAD\nHeading\n=======\n\nlocal\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<<<<<< HEAD\nHeading\n=======\n\nlocal\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<<<<<< HEAD\nHeading\n=======\n\nlocal\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
  },
  // A `||||||| note` line inside "ours" of the first of two blocks.
  barInOurs: {
    merge:
      "# T\n\n<<<<<<< HEAD\nStatus: local\n||||||| note\n=======\nStatus: remote\n>>>>>>> other\n\nMiddle 1\n\nMiddle 2\n\nMiddle 3\n\n<<<<<<< HEAD\nOwner: me\n=======\nOwner: them\n>>>>>>> other\n",
    diff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local\n||||||| note\n||||||| base\nStatus: draft\n=======\nStatus: remote\n>>>>>>> other\n\nMiddle 1\n\nMiddle 2\n\nMiddle 3\n\n<<<<<<< HEAD\nOwner: me\n||||||| base\nOwner: nobody\n=======\nOwner: them\n>>>>>>> other\n",
    zdiff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local\n||||||| note\n||||||| base\nStatus: draft\n=======\nStatus: remote\n>>>>>>> other\n\nMiddle 1\n\nMiddle 2\n\nMiddle 3\n\n<<<<<<< HEAD\nOwner: me\n||||||| base\nOwner: nobody\n=======\nOwner: them\n>>>>>>> other\n",
  },
  // A `>>>>>>> quoted` line inside "theirs".
  gtInTheirs: {
    merge:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\n=======\nStatus: remote edit\n>>>>>>> quoted\nmore\n>>>>>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> quoted\nmore\n>>>>>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<<<<<< HEAD\nStatus: local edit\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> quoted\nmore\n>>>>>>> other\n\nEnd\n",
  },
  // `*.md conflict-marker-size=10`, with lines of 7-character markers in "ours".
  size10: {
    merge:
      "# T\n\n<<<<<<<<<< HEAD\nStatus: local edit\n<<<<<<< x\n=======\n||||||| y\n>>>>>>> z\n==========\nStatus: remote edit\n>>>>>>>>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<<<<<<<<< HEAD\nStatus: local edit\n<<<<<<< x\n=======\n||||||| y\n>>>>>>> z\n|||||||||| base\nStatus: draft\n==========\nStatus: remote edit\n>>>>>>>>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<<<<<<<<< HEAD\nStatus: local edit\n<<<<<<< x\n=======\n||||||| y\n>>>>>>> z\n|||||||||| base\nStatus: draft\n==========\nStatus: remote edit\n>>>>>>>>>> other\n\nEnd\n",
  },
  // `*.md conflict-marker-size=3`, with a blockquote in "theirs".
  size3: {
    merge:
      "# T\n\n<<< HEAD\nStatus: local edit\n===\nStatus: remote edit\n> quote\n>>> other\n\nEnd\n",
    diff3:
      "# T\n\n<<< HEAD\nStatus: local edit\n||| base\nStatus: draft\n===\nStatus: remote edit\n> quote\n>>> other\n\nEnd\n",
    zdiff3:
      "# T\n\n<<< HEAD\nStatus: local edit\n||| base\nStatus: draft\n===\nStatus: remote edit\n> quote\n>>> other\n\nEnd\n",
  },
  // Git keeps the line endings of the conflicting lines: CRLF only in one side
  // gets markers with LF.
  mixedTheirs: {
    merge:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\n=======\nStatus: remote edit\r\nsecond remote\r\n>>>>>>> other\n\nFooter\n",
    diff3:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\r\nsecond remote\r\n>>>>>>> other\n\nFooter\n",
    zdiff3:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\r\nsecond remote\r\n>>>>>>> other\n\nFooter\n",
  },
  mixedOurs: {
    merge:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\r\nsecond local\r\n=======\nStatus: remote edit\n>>>>>>> other\n\nFooter\n",
    diff3:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\r\nsecond local\r\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nFooter\n",
    zdiff3:
      "# Title\n\n<<<<<<< HEAD\nStatus: local edit\r\nsecond local\r\n||||||| base\nStatus: draft\n=======\nStatus: remote edit\n>>>>>>> other\n\nFooter\n",
  },
};

const styles: Style[] = ["merge", "diff3", "zdiff3"];

function blocks(body: string, size = DEFAULT_CONFLICT_MARKER_SIZE) {
  return findConflictBlocks(body, size).map(({ ours, theirs, ambiguous }) => ({
    ours,
    theirs,
    ambiguous,
  }));
}

/** The document text around the blocks. */
function outside(body: string, size = DEFAULT_CONFLICT_MARKER_SIZE) {
  let cursor = 0;
  const parts: string[] = [];
  for (const block of findConflictBlocks(body, size)) {
    parts.push(body.slice(cursor, block.start));
    cursor = block.end;
  }
  parts.push(body.slice(cursor));
  return parts;
}

const sides = (ours: string, theirs: string) => [
  { ours, theirs, ambiguous: false },
];

test("marker-like text inside a side stays in that side in every style", () => {
  for (const style of styles) {
    expect(blocks(fixtures.xEquals[style])).toEqual(
      sides(
        "Status: local edit\nx=======\nformula a=======b",
        "Status: remote edit",
      ),
    );
    expect(blocks(fixtures.setext10[style])).toEqual(
      sides("Heading\n==========\n\nlocal", "Status: remote edit"),
    );
    expect(outside(fixtures.xEquals[style])).toEqual(["# T\n\n", "\nEnd\n"]);
  }
  for (const style of ["diff3", "zdiff3"] as const)
    expect(blocks(fixtures.setext7[style])).toEqual(
      sides("Heading\n=======\n\nlocal", "Status: remote edit"),
    );
});

test("a merge file whose block has a `|` line in ours keeps it as content", () => {
  expect(blocks(fixtures.barInOurs.merge)).toEqual(
    [
      { ours: "Status: local\n||||||| note", theirs: "Status: remote" },
      { ours: "Owner: me", theirs: "Owner: them" },
    ].map((block) => ({ ...block, ambiguous: false })),
  );
});

test("blocks take markers of the path size; other runs are content", () => {
  for (const style of styles) {
    expect(blocks(fixtures.size10[style], 10)).toEqual(
      sides(
        "Status: local edit\n<<<<<<< x\n=======\n||||||| y\n>>>>>>> z",
        "Status: remote edit",
      ),
    );
    expect(blocks(fixtures.size3[style], 3)).toEqual(
      sides("Status: local edit", "Status: remote edit\n> quote"),
    );
    expect(outside(fixtures.size10[style], 10)).toEqual(["# T\n\n", "\nEnd\n"]);
    // With the default size the file of size 3 holds no block.
    expect(blocks(fixtures.size3[style])).toEqual([]);
  }
});

test("sides end without the line ending of their last line under mixed endings", () => {
  for (const style of styles) {
    expect(blocks(fixtures.mixedTheirs[style])).toEqual(
      sides("Status: local edit", "Status: remote edit\r\nsecond remote"),
    );
    expect(blocks(fixtures.mixedOurs[style])).toEqual(
      sides("Status: local edit\r\nsecond local", "Status: remote edit"),
    );
  }
  // CRLF marker lines; a lone `\r` without `\n` belongs to the line.
  expect(
    blocks("<<<<<<< a\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> b\r\n"),
  ).toEqual(sides("mine", "theirs"));
  expect(blocks("<<<<<<< a\nmine\n=======\r\ntheirs\n>>>>>>> b")).toEqual(
    sides("mine", "theirs"),
  );
  expect(blocks("<<<<<<< a\nmine\n=======\rx\ntheirs\n>>>>>>> b\n")).toEqual(
    [],
  );
});

test("a `<` line without `=` and `>` lines after it stays text", () => {
  for (const body of [
    "Intro\n<<<<<<< HEAD\nmine\n",
    "Intro\n<<<<<<< HEAD\nmine\n=======\ntheirs\n",
    "Intro\n<<<<<<<\nmine\n=======\ntheirs\n>>>>>>>\n",
    "Intro\n <<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n",
  ])
    expect(blocks(body)).toEqual([]);
  // After the last block.
  expect(
    blocks("<<<<<<< a\nmine\n=======\ntheirs\n>>>>>>> b\n<<<<<<< c\nrest\n"),
  ).toEqual(sides("mine", "theirs"));
});

test("blocks whose marker lines allow another split are ambiguous and take the first split", () => {
  expect(blocks(fixtures.setext7.merge)).toEqual([
    {
      ours: "Heading",
      theirs: "\nlocal\n=======\nStatus: remote edit",
      ambiguous: true,
    },
  ]);
  for (const style of ["diff3", "zdiff3"] as const)
    expect(blocks(fixtures.barInOurs[style])).toEqual([
      { ours: "Status: local", theirs: "Status: remote", ambiguous: true },
      { ours: "Owner: me", theirs: "Owner: them", ambiguous: false },
    ]);
  for (const style of styles)
    expect(blocks(fixtures.gtInTheirs[style])).toEqual([
      {
        ours: "Status: local edit",
        theirs: "Status: remote edit",
        ambiguous: true,
      },
    ]);
  // A `<` line before the block without its own `=` and `>` lines.
  expect(
    blocks(
      "Intro\n<<<<<<< note\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n",
    ),
  ).toEqual([
    {
      ours: "\n<<<<<<< HEAD\nmine",
      theirs: "theirs",
      ambiguous: true,
    },
  ]);
  // A second `=` line in "theirs" or in the base.
  expect(
    blocks("<<<<<<< a\nmine\n=======\ntheirs\n=======\n>>>>>>> b\n"),
  ).toEqual([{ ours: "mine", theirs: "theirs\n=======", ambiguous: true }]);
  expect(
    blocks(
      "<<<<<<< a\nmine\n||||||| base\nold\n=======\nolder\n=======\ntheirs\n>>>>>>> b\n",
    ),
  ).toEqual([
    { ours: "mine", theirs: "older\n=======\ntheirs", ambiguous: true },
  ]);
});

test("Git is needed only for a body with a line starting with `<` and a space", () => {
  for (const body of [
    "<<<<<<< HEAD\n",
    "text\n<<< HEAD",
    "text\r\n<<<<<<<<<< HEAD\r\n",
    "text\n< x",
  ])
    expect(hasConflictMarkerCandidate(body)).toBe(true);
  for (const body of [
    "",
    "Plain text\n\n=======\n>>>>>>> other\n",
    "text <<<<<<< HEAD\n",
    " <<<<<<< HEAD\n",
    "<<<<<<<\n",
    "<<<<<<<x\n",
    "text\r<<<<<<< HEAD",
  ])
    expect(hasConflictMarkerCandidate(body)).toBe(false);
});
