import { expect, test } from "bun:test";
import { conflictDisplayText } from "./conflict-display";

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
  const text = conflictDisplayText(
    content,
    [
      {
        startLine: 1,
        endLine: 6,
        ours: "mine\n=======",
        theirs: "theirs",
      },
    ],
    labels,
  );
  expect(text).toBe(
    [
      "head\n",
      "<<<<<<< Mine\n",
      "mine\n",
      "\u200b=======\n",
      "=======\n",
      "theirs\n",
      ">>>>>>> Incoming\n",
      "\u200b<<<<<<< text\n",
      "tail",
    ].join(""),
  );
});

test("an empty side has no lines and CRLF text stays as it is", () => {
  const content = "a\r\n<<<<<<< x\r\n=======\r\nb\r\n>>>>>>> y\r\nc\r\n";
  expect(
    conflictDisplayText(
      content,
      [{ startLine: 1, endLine: 4, ours: "", theirs: "b" }],
      labels,
    ),
  ).toBe("a\r\n<<<<<<< Mine\n=======\nb\n>>>>>>> Incoming\nc\r\n");
});
