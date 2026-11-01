import { expect, test } from "bun:test";
import { conflictDisplay } from "./conflict-display";

const labels = { ours: "Mine", theirs: "Incoming" };

test("shows Svode's places as blocks and keeps marker-like text out of them", () => {
  const content = [
    "head\n",
    "<<<<<<<<<< ours\n",
    "mine\n",
    "=======\n",
    "==========\n",
    "theirs\n",
    ">>>>>>>>>> theirs\n",
    "<<<<<<< text\n",
    "tail",
  ].join("");
  const display = conflictDisplay(
    content,
    [
      {
        startLine: 1,
        endLine: 6,
        ours: "mine\n=======",
        theirs: "theirs",
        frontmatter: false,
      },
    ],
    [null],
    labels,
  );
  expect(display.text).toBe(
    [
      "head\n",
      "<<<<<<< Mine\n",
      "mine\n",
      "​=======\n",
      "=======\n",
      "theirs\n",
      ">>>>>>> Incoming\n",
      "​<<<<<<< text\n",
      "tail",
    ].join(""),
  );
  expect(display.open).toEqual([0]);
  expect(display.chosen).toEqual([]);
});

test("an empty side has no lines and CRLF text stays as it is", () => {
  const content = "a\r\n<<<<<<< x\r\n=======\r\nb\r\n>>>>>>> y\r\nc\r\n";
  expect(
    conflictDisplay(
      content,
      [{ startLine: 1, endLine: 4, ours: "", theirs: "b", frontmatter: false }],
      [null],
      labels,
    ).text,
  ).toBe("a\r\n<<<<<<< Mine\n=======\nb\n>>>>>>> Incoming\nc\r\n");
});

const content = [
  "head\n",
  "<<<<<<< ours\n",
  "one\n",
  "=======\n",
  "uno\n",
  "dos\n",
  ">>>>>>> theirs\n",
  "middle\n",
  "<<<<<<< ours\n",
  "two\n",
  "=======\n",
  "deux\n",
  ">>>>>>> theirs\n",
  "tail\n",
].join("");
const places = [
  {
    startLine: 1,
    endLine: 6,
    ours: "one",
    theirs: "uno\ndos",
    frontmatter: false,
  },
  {
    startLine: 8,
    endLine: 12,
    ours: "two",
    theirs: "deux",
    frontmatter: false,
  },
];

test("a chosen place shows the text of its side and is marked at its last line", () => {
  const display = conflictDisplay(content, places, ["both", null], labels);
  expect(display.text).toBe(
    [
      "head\n",
      "one\n",
      "uno\n",
      "dos\n",
      "middle\n",
      "<<<<<<< Mine\n",
      "two\n",
      "=======\n",
      "deux\n",
      ">>>>>>> Incoming\n",
      "tail\n",
    ].join(""),
  );
  // The component reads one block: the second place of Svode.
  expect(display.open).toEqual([1]);
  expect(display.chosen).toEqual([{ place: 0, choice: "both", lineNumber: 4 }]);
});

test("a mark counts the lines of the incoming side of the open places before it", () => {
  const display = conflictDisplay(content, places, [null, "ours"], labels);
  expect(display.open).toEqual([0]);
  // head, uno, dos, middle, two: «two» is the fifth incoming line.
  expect(display.chosen).toEqual([{ place: 1, choice: "ours", lineNumber: 5 }]);
  const all = conflictDisplay(content, places, ["theirs", "ours"], labels);
  expect(all.open).toEqual([]);
  expect(all.text).toBe("head\nuno\ndos\nmiddle\ntwo\ntail\n");
  expect(all.chosen).toEqual([
    { place: 0, choice: "theirs", lineNumber: 3 },
    { place: 1, choice: "ours", lineNumber: 5 },
  ]);
});

test("a chosen empty side shows one empty line for its mark and marker-like text is kept out", () => {
  const display = conflictDisplay(
    "<<<<<<< a\n=======\n<<<<<<< not a marker\n>>>>>>> b\nrest\n",
    [
      {
        startLine: 0,
        endLine: 3,
        ours: "",
        theirs: "<<<<<<< not a marker",
        frontmatter: false,
      },
    ],
    ["ours"],
    labels,
  );
  expect(display.text).toBe("\nrest\n");
  expect(display.chosen).toEqual([{ place: 0, choice: "ours", lineNumber: 1 }]);
  expect(
    conflictDisplay(
      "<<<<<<< a\n=======\n<<<<<<< not a marker\n>>>>>>> b\n",
      [
        {
          startLine: 0,
          endLine: 3,
          ours: "",
          theirs: "<<<<<<< not a marker",
          frontmatter: false,
        },
      ],
      ["theirs"],
      labels,
    ).text,
  ).toBe("​<<<<<<< not a marker\n");
});
