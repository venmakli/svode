import { expect, test } from "bun:test";
import { humanAvatar } from "./avatar-presentation";

const golden = [
  [0, "#06B6D4"],
  [1, "#F97316"],
  [2, "#10B981"],
  [3, "#EC4899"],
  [5, "#14B8A6"],
  [6, "#8B5CF6"],
  [7, "#EF4444"],
  [10, "#F59E0B"],
  [11, "#3B82F6"],
  [17, "#6366F1"],
] as const;

test("normalized email keys preserve the sidebar FNV-1a palette and ignore display name", () => {
  for (const [id, backgroundColor] of golden) {
    const email = `person${id}@example.test`;
    expect(humanAvatar({ email }).style.backgroundColor).toBe(backgroundColor);
    expect(
      humanAvatar({ email: ` ${email.toUpperCase()} `, name: "Other Name" })
        .style.backgroundColor,
    ).toBe(backgroundColor);
  }
});

test("one Unicode letter, name/email fallback, and missing identity are locale independent", () => {
  for (const [name, email, expected] of [
    ["venmak.li", "v@example.test", "V"],
    [" Ada Lovelace ", "a@example.test", "A"],
    [" илья Камнев ", "a@example.test", "И"],
    ["𐐨", "a@example.test", "𐐀"],
    ["ß", "a@example.test", "S"],
    ["istanbul", "a@example.test", "I"],
    [" ", " EMAIL@example.test ", "E"],
    ["", "", "?"],
  ])
    expect(humanAvatar({ name, email }).initials).toBe(expected);
  expect(humanAvatar(null)).toEqual({
    initials: "?",
    style: { backgroundColor: "#9CA3AF", color: "#000000" },
  });
  expect(
    humanAvatar({ name: "Ada", email: " \t " }).style.backgroundColor,
  ).toBe("#9CA3AF");
  const source = Object.freeze({ name: " Ada ", email: " ADA@example.test " });
  humanAvatar(source);
  expect(source.email).toBe(" ADA@example.test ");
});

test("foreground meets normal-text contrast on every preserved background in either theme", () => {
  for (const [id] of golden) {
    const { style } = humanAvatar({ email: `person${id}@example.test` });
    const rgb = style.backgroundColor
      .match(/[\da-f]{2}/gi)!
      .map((hex) => parseInt(hex, 16) / 255);
    const linear = rgb.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    const luminance = linear.reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
    const contrast =
      style.color === "#000000"
        ? (luminance + 0.05) / 0.05
        : 1.05 / (luminance + 0.05);
    expect(contrast >= 4.5).toBe(true);
  }
});
